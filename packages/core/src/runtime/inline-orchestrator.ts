/**
 * **Experimental.** Running a run's orchestrator delivery in the process that
 * sent it (`start(..., { experimental_inline: true })`,
 * `resumeHook(..., { experimental_inline: true })`), with no queue hop.
 *
 * The orchestrator message is sent with `experimental_hold` (see
 * `QueueOptions.experimental_hold` in `@workflow/world`). When the queue holds
 * it for this process, the same handler the flow route passes to
 * `createQueueHandler()` runs it here, as its first delivery, under
 * `waitUntil`; the queue stays the backstop and delivers the message to the
 * flow route as usual if this process stops renewing the hold. In every other
 * case (the World cannot hold, the message was not held, no handler is loaded
 * in this process, the hold attempt threw) the message is the queue's to
 * deliver, exactly as without the option. Nothing here ever processes a
 * message the queue did not hand to this process.
 *
 * The handler is only present in a process that loaded the app's generated
 * flow route module (`workflowEntrypoint()` registers it in a process-wide
 * registry when it is created). An API route opts in to bundling it by
 * importing the flow entry (`workflow/next/inline` with `withWorkflow`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Span } from '@opentelemetry/api';
import { globalSingleton } from '@workflow/utils';
import type {
  QueueHandler,
  QueueHoldResult,
  QueueOptions,
  QueueResult,
  ValidQueueName,
  World,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { contextStorage } from '../step/context-storage.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { trace } from '../telemetry.js';
import { safeWaitUntil } from './wait-until.js';

/** Kill switch: `0` turns every inline request into a plain queued send. */
export const INLINE_ENV = 'WORKFLOW_EXPERIMENTAL_INLINE';

/**
 * Why an inline request took the plain queued path. A bounded set, so it can
 * be a span attribute value.
 */
export type InlineSkipReason =
  /** `WORKFLOW_EXPERIMENTAL_INLINE=0`. */
  | 'disabled'
  /** The World does not declare `capabilities.experimental_queueHold`. */
  | 'no_capability'
  /** No flow entry was loaded in this process for the message's prefix. */
  | 'no_handler'
  /** The run is pinned to another deployment. */
  | 'other_deployment'
  /** The run's data lives in a region other than this function's. */
  | 'other_region'
  /** Called from inside a step (a child run started by a workflow). */
  | 'in_step'
  /** A start shape this proposal does not inline (start Hook, dynamic). */
  | 'unsupported_start';

/** What an inline request came to; the `workflow.inline.outcome` value. */
export type InlineOutcome =
  | 'held'
  | 'not_held'
  | 'skipped'
  | 'hold_failed'
  | 'no_hold_result';

/** A flow entry's orchestrator handler, registered by `workflowEntrypoint()`. */
interface InlineEntry {
  /** The queue prefix the flow route consumes (`__wkf_workflow_` etc.). */
  prefix: string;
  /** Builds the handler for a World; called at most once per World. */
  createHandler(world: World): QueueHandler;
  handlers: WeakMap<World, QueueHandler>;
}

// On `globalThis` so the registry is shared by every copy of this module a
// bundler emits: the flow entry and the calling route can resolve
// `@workflow/core` to different copies in one server build.
const registry = globalSingleton(
  '@workflow/core//inlineOrchestrator',
  1,
  () => ({
    entries: new Map<string, InlineEntry>(),
    warnedNoHandler: false,
  })
);

/**
 * Registers the orchestrator handler of a flow entry so `start()` and
 * `resumeHook()` in this process can run held orchestrator messages with it.
 * Called by `workflowEntrypoint()`. The last registration for a prefix wins
 * (one app has one flow entry per queue namespace).
 *
 * @internal
 */
export function registerInlineOrchestrator(
  prefix: string,
  createHandler: (world: World) => QueueHandler
): void {
  registry.entries.set(prefix, {
    prefix,
    createHandler,
    handlers: new WeakMap(),
  });
}

/** Test seam: forget every registered flow entry. @internal */
export function resetInlineOrchestratorsForTests(): void {
  registry.entries.clear();
  registry.warnedNoHandler = false;
}

function entryFor(queueName: string): InlineEntry | undefined {
  // The longest prefix that matches: a namespaced prefix
  // (`__eve_wkf_workflow_`) never matches the default one, but be exact.
  let best: InlineEntry | undefined;
  for (const entry of registry.entries.values()) {
    if (
      queueName.startsWith(entry.prefix) &&
      (!best || entry.prefix.length > best.prefix.length)
    ) {
      best = entry;
    }
  }
  return best;
}

function handlerFor(entry: InlineEntry, world: World): QueueHandler {
  let handler = entry.handlers.get(world);
  if (!handler) {
    handler = entry.createHandler(world);
    entry.handlers.set(world, handler);
  }
  return handler;
}

/** The facts about one orchestrator send that decide whether to inline it. */
export interface InlineRequest {
  world: World;
  queueName: ValidQueueName;
  runId: string;
  /** The run's pinned deployment is the World's current one. */
  sameDeployment: boolean;
  /** Set when the caller's start shape cannot be inlined. */
  unsupported?: boolean;
}

export type InlineDecision =
  | { inline: true; handler: QueueHandler }
  | { inline: false; reason: InlineSkipReason };

/**
 * Whether an orchestrator send the caller asked to inline can be: every
 * condition is checked before anything is sent, so a `false` costs nothing
 * and the send is exactly the one made without the option.
 */
export function decideInline(request: InlineRequest): InlineDecision {
  if (process.env[INLINE_ENV] === '0') {
    return { inline: false, reason: 'disabled' };
  }
  if (request.unsupported) {
    return { inline: false, reason: 'unsupported_start' };
  }
  if (request.world.capabilities?.experimental_queueHold !== true) {
    return { inline: false, reason: 'no_capability' };
  }
  // A step's process is a flow route already running a delivery of another
  // run: an inline child would share that invocation's budget and outlive
  // the step under `waitUntil`. The queue runs it instead.
  if (contextStorage.getStore() !== undefined) {
    return { inline: false, reason: 'in_step' };
  }
  if (!request.sameDeployment) {
    return { inline: false, reason: 'other_deployment' };
  }
  // A run's data lives in the region its ID is tagged with. Running its
  // orchestrator from another region would make every event write a
  // cross-region round trip, which defeats the point; the queue routes it.
  const runRegion = request.world.regionForRunId?.(request.runId) ?? undefined;
  const hereRegion = process.env.VERCEL_REGION;
  if (runRegion && hereRegion && runRegion !== hereRegion) {
    return { inline: false, reason: 'other_region' };
  }
  const entry = entryFor(request.queueName);
  if (!entry) {
    if (!registry.warnedNoHandler) {
      registry.warnedNoHandler = true;
      runtimeLogger.warn(
        'experimental_inline was requested, but this process has not loaded the workflow flow entry, so the run is queued as usual. ' +
          "Import it in the route that calls start() or resumeHook() (with Next.js: `import 'workflow/next/inline'`).",
        { queueName: request.queueName }
      );
    }
    return { inline: false, reason: 'no_handler' };
  }
  try {
    return { inline: true, handler: handlerFor(entry, request.world) };
  } catch (error) {
    runtimeLogger.warn(
      'Could not build the inline orchestrator handler; the run is queued as usual',
      {
        queueName: request.queueName,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return { inline: false, reason: 'no_handler' };
  }
}

/**
 * The deadline an inline delivery must hand off by: the calling route's own
 * function deadline, which is usually shorter than the flow route's. Read by
 * `getMaxInlineDurationMs` so an inline delivery stops starting inline work
 * in time and continues on the queue (`{ timeoutSeconds: 0 }`).
 */
interface InlineDeliveryContext {
  /** When the held message started running here (epoch ms). */
  startedAt: number;
}

const inlineDeliveryStorage = globalSingleton(
  '@workflow/core//inlineDeliveryStorage',
  1,
  () => ({ storage: new AsyncLocalStorage<InlineDeliveryContext>() })
).storage;

/** The inline delivery this code runs in, if any. @internal */
export function currentInlineDelivery(): InlineDeliveryContext | undefined {
  return inlineDeliveryStorage.getStore();
}

/** What an inline delivery leaves of its route's deadline for the handoff. */
export const INLINE_HANDOFF_MARGIN_MS = 15_000;

/**
 * How long an inline delivery may run before it hands off, given the calling
 * function's deadline: what is left of it, minus a margin for the handoff
 * itself, capped at `budgetMs` (the flow route's own budget). `budgetMs`
 * when the deadline is unknown.
 *
 * @internal
 */
export function inlineBudgetMs(
  invocationStartTime: number,
  deadline: Date | undefined,
  budgetMs: number
): number {
  if (!deadline) return budgetMs;
  const deadlineMs = deadline.getTime();
  if (Number.isNaN(deadlineMs)) return budgetMs;
  const available = deadlineMs - INLINE_HANDOFF_MARGIN_MS - invocationStartTime;
  // At least a moment, so a route already near its deadline hands off on the
  // first boundary instead of refusing to run anything.
  return Math.max(1_000, Math.min(budgetMs, available));
}

/**
 * Sends one orchestrator message, holding it for this process when
 * `decision` says so, and runs a held message with the flow entry's handler
 * under `waitUntil`. Resolves with the send's result once the message is
 * accepted by the queue, before the inline delivery finishes.
 *
 * `send(hold, inlineAttempt)` performs the caller's own send, with
 * `experimental_hold` added when `hold` carries it. `inlineAttempt` is `true`
 * for the held attempt and for the plain resend made only if that attempt
 * throws, so a caller can give both the same `idempotencyKey`; it is `false`
 * for a skipped request, which must be exactly the send made without the
 * option.
 */
export async function sendOrchestratorMessage(params: {
  decision: InlineDecision;
  runId: string;
  span: Span | undefined;
  send: (
    hold: Pick<QueueOptions, 'experimental_hold'>,
    inlineAttempt: boolean
  ) => Promise<QueueResult>;
}): Promise<QueueResult> {
  const { decision, runId, span } = params;
  if (!decision.inline) {
    span?.setAttributes({
      ...Attribute.WorkflowInlineOutcome('skipped'),
      ...Attribute.WorkflowInlineSkipReason(decision.reason),
    });
    return params.send({}, false);
  }
  let result: QueueResult;
  try {
    result = await params.send({ experimental_hold: true }, true);
  } catch (error) {
    // Fail closed: whatever the held attempt did, it did not hand this
    // process a message. Send as usual; the shared idempotency key (where the
    // caller sends one) keeps a held attempt that did enqueue from being
    // delivered twice, and its hold lapses into a normal delivery.
    span?.setAttributes(Attribute.WorkflowInlineOutcome('hold_failed'));
    runtimeLogger.warn(
      'experimental_inline: the held send failed; sending the orchestrator message as usual',
      {
        workflowRunId: runId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return params.send({}, true);
  }
  const hold: QueueHoldResult | undefined = result.experimental_hold;
  if (hold?.status !== 'held') {
    span?.setAttributes({
      ...Attribute.WorkflowInlineOutcome(hold ? 'not_held' : 'no_hold_result'),
      ...(hold ? Attribute.WorkflowInlineNotHeldReason(hold.reason) : {}),
    });
    return result;
  }
  span?.setAttributes(Attribute.WorkflowInlineOutcome('held'));
  const handler = decision.handler;
  safeWaitUntil(
    // Started now, not after the caller's other writes: nothing renews the
    // hold until `consume()` runs.
    trace('workflow.inline.consume', async (consumeSpan) => {
      consumeSpan?.setAttributes({
        ...Attribute.WorkflowRunId(runId),
        ...Attribute.MessagingMessageId(hold.messageId),
      });
      await inlineDeliveryStorage.run({ startedAt: Date.now() }, () =>
        hold.consume(handler)
      );
    }),
    (error) => {
      // The hold lapses and the queue delivers the message to the flow route;
      // the run's log is fenced against this delivery having written part of
      // it. Nothing to do here but say so.
      runtimeLogger.warn(
        'experimental_inline: the inline orchestrator delivery failed; the queue redelivers it',
        {
          workflowRunId: runId,
          messageId: hold.messageId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  );
  return result;
}
