/**
 * Running a run's orchestrator delivery in the process that sent it, with no
 * queue hop: what `start()` and `resumeHook()` do by default on a World that
 * can hold a message for its sender (`capabilities.experimental_queueHold`).
 *
 * The orchestrator message is sent with `experimental_hold` (see
 * `QueueOptions.experimental_hold` in `@workflow/world`). When the queue holds
 * it for this process, the same handler the flow route passes to
 * `createQueueHandler()` runs it here, as its first delivery, under
 * `waitUntil`; the queue stays the backstop and delivers the message to the
 * flow route as usual if this process stops renewing the hold. In every other
 * case (the World cannot hold, the message was not held, no flow entry can be
 * loaded in this process, the hold attempt threw) the message is the queue's
 * to deliver, exactly as before. Nothing here ever processes a message the
 * queue did not hand to this process.
 *
 * The handler comes from the app's generated flow entry: `workflowEntrypoint()`
 * registers it in a process-wide registry when the module is evaluated. The
 * flow route has it already; any other route loads it on demand through
 * `@workflow/core/inline-entry`, which the framework integration aliases to
 * the generated flow route for server builds (an empty module otherwise, so
 * that process keeps queueing).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Span } from '@opentelemetry/api';
import { globalSingleton } from '@workflow/utils';
import {
  type QueueHandler,
  type QueueHoldResult,
  type QueueOptions,
  type QueueResult,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type ValidQueueName,
  type World,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { contextStorage } from '../step/context-storage.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { trace } from '../telemetry.js';
import { getComputeInstanceId } from './compute-instance.js';
import { safeWaitUntil } from './wait-until.js';

/**
 * Kill switch: `WORKFLOW_INLINE_DELIVERY=0` turns every orchestrator send back
 * into the plain queued send, and stops this process loading the flow entry.
 */
export const INLINE_ENV = 'WORKFLOW_INLINE_DELIVERY';

/**
 * Why an inline request took the plain queued path. A bounded set, so it can
 * be a span attribute value.
 */
export type InlineSkipReason =
  /** `WORKFLOW_INLINE_DELIVERY=0`. */
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
  /**
   * The entry serves exactly one workflow's queue (`prefix` is its whole
   * queue name): a per-workflow entry, which carries that workflow's code and
   * relies on the calling route's own module graph for its steps.
   */
  exact: boolean;
  /** Builds the handler for a World; called at most once per World. */
  createHandler(world: World): QueueHandler;
  handlers: WeakMap<World, QueueHandler>;
  /** See {@link InlinePrewarm}. */
  prewarm?: InlinePrewarm;
}

/**
 * Speculative, side-effect-free preparation for running `message` here: what
 * an orchestrator delivery of it would set up before its first world write
 * (loading the run's orchestrator, compiling the workflow bundle or the
 * QuickJS baseline, building the World), into the process caches the
 * delivery reads. It writes nothing, holds no lease, starts no step and leaves
 * no timer or stream open, so it is safe to start before the queue has said
 * whether this process holds the message, and to abandon if it does not.
 */
export type InlinePrewarm = (
  message: unknown,
  queueName: string
) => Promise<void>;

/**
 * `WORKFLOW_INLINE_SPECULATION=0` stops a held send from preparing its
 * delivery while the hold's answer is in flight (see {@link InlinePrewarm});
 * the delivery then prepares itself after the answer, as before.
 */
export const INLINE_SPECULATION_ENV = 'WORKFLOW_INLINE_SPECULATION';

// On `globalThis` so the registry is shared by every copy of this module a
// bundler emits: the flow entry and the calling route can resolve
// `@workflow/core` to different copies in one server build.
const registry = globalSingleton(
  '@workflow/core//inlineOrchestrator',
  3,
  () => ({
    entries: new Map<string, InlineEntry>(),
    /** The one load of `@workflow/core/inline-entry` this process makes. */
    entryLoad: undefined as Promise<void> | undefined,
    /** Loads of per-workflow entries, by workflow name. */
    workflowLoads: new Map<string, Promise<void>>(),
  })
);

/**
 * Where a framework integration registers per-workflow inline entries: a
 * `Map` from workflow name (its `workflowId`) to a function importing the
 * generated module that holds that workflow's code. The integration's
 * transform adds the entries to the workflow's own module, so only routes
 * that import a workflow carry its entry, and it is loaded on the first
 * `start()` or `resumeHook()` of that workflow in the process.
 */
export const INLINE_WORKFLOW_LOADERS_KEY = Symbol.for(
  '@workflow/core//inlineWorkflowLoaders'
);

function inlineWorkflowLoader(
  workflowName: string
): (() => Promise<unknown>) | undefined {
  const loaders = (globalThis as Record<symbol, unknown>)[
    INLINE_WORKFLOW_LOADERS_KEY
  ] as Map<string, () => Promise<unknown>> | undefined;
  return loaders?.get(workflowName);
}

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
  createHandler: (world: World) => QueueHandler,
  prewarm?: InlinePrewarm,
  options?: { exact?: boolean }
): void {
  const exact = options?.exact === true;
  registry.entries.set(exact ? `=${prefix}` : prefix, {
    prefix,
    exact,
    createHandler,
    handlers: new WeakMap(),
    ...(prewarm && { prewarm }),
  });
}

/** Test seam: forget every registered flow entry. @internal */
export function resetInlineOrchestratorsForTests(): void {
  registry.entries.clear();
  registry.entryLoad = undefined;
  registry.workflowLoads.clear();
}

/**
 * Why a send from this call cannot run inline, or `undefined` when it may:
 * the cheap gate in front of {@link loadInlineEntry}, so a World that cannot
 * hold (local development, Postgres), the kill switch, and a call from inside
 * a step never load the flow entry.
 */
export function inlineGate(world: World): InlineSkipReason | undefined {
  if (process.env[INLINE_ENV] === '0') return 'disabled';
  if (world.capabilities?.experimental_queueHold !== true) {
    return 'no_capability';
  }
  // Inside a step, or anywhere else in an orchestrator delivery (a lifecycle
  // hook): an inline child would share that invocation's budget and outlive
  // it under `waitUntil`. The queue runs it instead.
  if (
    contextStorage.getStore() !== undefined ||
    orchestratorDeliveryStorage.getStore() === true
  ) {
    return 'in_step';
  }
  return undefined;
}

/** Whether a send from this call could run inline at all (see {@link inlineGate}). */
export function mayInline(world: World): boolean {
  return inlineGate(world) === undefined;
}

/**
 * Records on `span` why a send that could have been held was not. A World
 * that cannot hold records nothing: there was never an inline path.
 */
export function recordInlineGate(
  span: Span | undefined,
  reason: InlineSkipReason | undefined
): void {
  if (reason === undefined || reason === 'no_capability') return;
  span?.setAttributes({
    ...Attribute.WorkflowInlineOutcome('skipped'),
    ...Attribute.WorkflowInlineSkipReason(reason),
  });
}

/**
 * How long a send waits for the flow entry's first load in this process
 * before going to the queue instead. The load (evaluating the app's
 * workflows, steps and their dependencies) usually takes far less than the
 * queue hop it saves; the bound keeps a slow cold load from holding up the
 * caller, and the load still finishes in the background for later sends.
 */
export const INLINE_ENTRY_LOAD_WAIT_MS = 1_000;

/**
 * Loads the app's flow entry into this process once, so its orchestrator
 * handler is registered. Resolves when it is loaded, when it could not be
 * (the specifier is the empty default outside a framework that aliases it,
 * or the import failed), or after `waitMs`, whichever is first: never
 * rejects. A no-op in a process that already registered a handler (the flow
 * route itself).
 */
export function loadInlineEntry(
  waitMs: number = INLINE_ENTRY_LOAD_WAIT_MS,
  target?: { queueName: string; workflowName: string }
): Promise<void> {
  let load: Promise<void>;
  const loader = target && inlineWorkflowLoader(target.workflowName);
  if (target && entryFor(target.queueName)) return Promise.resolve();
  if (target && loader) {
    // A per-workflow entry: only this workflow's code (see
    // `INLINE_WORKFLOW_LOADERS_KEY`).
    const name = target.workflowName;
    let workflowLoad = registry.workflowLoads.get(name);
    if (!workflowLoad) {
      workflowLoad = Promise.resolve()
        .then(loader)
        .then(
          () => undefined,
          (error: unknown) => {
            runtimeLogger.debug(
              'Could not load the workflow inline entry; runs are queued as usual',
              {
                workflowName: name,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        );
      registry.workflowLoads.set(name, workflowLoad);
    }
    load = workflowLoad;
  } else {
    if ([...registry.entries.values()].some((entry) => !entry.exact)) {
      return Promise.resolve();
    }
    registry.entryLoad ??= import('@workflow/core/inline-entry').then(
      () => undefined,
      (error: unknown) => {
        runtimeLogger.debug(
          'Could not load the workflow flow entry for inline delivery; runs are queued as usual',
          { error: error instanceof Error ? error.message : String(error) }
        );
      }
    );
    load = registry.entryLoad;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    load,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Set while this process runs an orchestrator delivery (the flow route's, or
 * an inline one): a `start()` or `resumeHook()` made from inside it (a step,
 * a lifecycle hook) is queued, so a child run never shares the parent
 * delivery's invocation budget.
 */
const orchestratorDeliveryStorage = globalSingleton(
  '@workflow/core//orchestratorDeliveryStorage',
  1,
  () => ({ storage: new AsyncLocalStorage<true>() })
).storage;

/** Runs `fn` as part of an orchestrator delivery (see above). @internal */
export function runAsOrchestratorDelivery<T>(fn: () => T): T {
  return orchestratorDeliveryStorage.run(true, fn);
}

function entryFor(queueName: string): InlineEntry | undefined {
  const exact = registry.entries.get(`=${queueName}`);
  if (exact) return exact;
  // The longest prefix that matches: a namespaced prefix
  // (`__eve_wkf_workflow_`) never matches the default one, but be exact.
  let best: InlineEntry | undefined;
  for (const entry of registry.entries.values()) {
    if (
      !entry.exact &&
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
  /** The run's spec version, when known. */
  runSpecVersion?: number;
}

export type InlineDecision =
  | { inline: true; handler: QueueHandler; prewarm?: InlinePrewarm }
  | { inline: false; reason: InlineSkipReason };

/**
 * Whether an orchestrator send can run inline: every condition is checked
 * before anything is sent, so a `false` costs nothing and the send is exactly
 * the queued one. Call {@link loadInlineEntry} first where {@link mayInline}.
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
    // Expected where the framework does not alias the flow entry: the run is
    // queued, as before.
    return { inline: false, reason: 'no_handler' };
  }
  // A per-workflow entry brings the workflow's code but not its steps: they
  // run here only when this process has them (the route imports the
  // workflow, so its module graph registered them), and are queued to the
  // flow route otherwise. Only the spec 8 Node.js VM delivery makes that
  // per-step choice so far; other runs go to the queue.
  if (
    entry.exact &&
    ((request.runSpecVersion ?? 0) >= SPEC_VERSION_SINGLE_ORCHESTRATOR ||
      process.env.WORKFLOW_VM === 'quickjs')
  ) {
    return { inline: false, reason: 'unsupported_start' };
  }
  try {
    return {
      inline: true,
      handler: handlerFor(entry, request.world),
      ...(entry.prewarm && { prewarm: entry.prewarm }),
    };
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
  /** The `workflow.inline.consume` span, for the first-step timing. */
  span?: Span;
  /** When the sending call began (epoch ms), if it says. */
  sendStartedAt?: number;
  /** Set once the delivery's first step body started. */
  firstStepNoted?: boolean;
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

/**
 * Called by the step executors as a step body starts: the first one in an
 * inline delivery stamps the delivery's span with how long it took to get
 * there, from the hold being consumed and from the sending call. A no-op
 * outside an inline delivery and after the first step. @internal
 */
export function noteInlineStepStarted(): void {
  const context = inlineDeliveryStorage.getStore();
  if (!context || context.firstStepNoted) return;
  context.firstStepNoted = true;
  const now = Date.now();
  context.span?.setAttributes({
    ...Attribute.WorkflowInlineFirstStepMs(now - context.startedAt),
    ...(context.sendStartedAt !== undefined
      ? Attribute.WorkflowInlineTimeToFirstStepMs(now - context.sendStartedAt)
      : {}),
  });
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
  /** The message `send` sends, for speculation (see {@link InlinePrewarm}). */
  message?: unknown;
  queueName?: string;
  /** When the calling `start()` / `resumeHook()` began (epoch ms). */
  callStartedAt?: number;
}): Promise<QueueResult> {
  const { decision, runId, span } = params;
  if (!decision.inline) {
    span?.setAttributes({
      ...Attribute.WorkflowInlineOutcome('skipped'),
      ...Attribute.WorkflowInlineSkipReason(decision.reason),
    });
    return params.send({}, false);
  }
  // Overlap the hold's round trip with the delivery's deterministic setup.
  // Nothing it does needs the hold, so it starts before the answer; the
  // delivery itself, and every write and step, still waits for `held`.
  const speculation = speculate(decision, params, span);
  const sendStartedAt = Date.now();
  let result: QueueResult;
  try {
    result = await params.send({ experimental_hold: true }, true);
    span?.setAttributes(
      Attribute.WorkflowInlineHoldSendMs(Date.now() - sendStartedAt)
    );
  } catch (error) {
    // Fail closed: whatever the held attempt did, it did not hand this
    // process a message. Send as usual; the shared idempotency key (where the
    // caller sends one) keeps a held attempt that did enqueue from being
    // delivered twice, and its hold lapses into a normal delivery.
    span?.setAttributes(Attribute.WorkflowInlineOutcome('hold_failed'));
    runtimeLogger.warn(
      'Inline delivery: the held send failed; sending the orchestrator message as usual',
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
        ...Attribute.WorkflowRouteType('inline'),
        ...Attribute.FaasInstance(getComputeInstanceId()),
        ...Attribute.WorkflowRunId(runId),
        ...Attribute.MessagingMessageId(hold.messageId),
        ...Attribute.WorkflowInlineSpeculation(speculation.state),
      });
      // Recorded once the speculation settles, while the delivery (and so
      // this span) is still running in the common case.
      void speculation.done.then((elapsedMs) => {
        if (elapsedMs !== undefined) {
          consumeSpan?.setAttributes(
            Attribute.WorkflowInlineSpeculationMs(elapsedMs)
          );
        }
      });
      await inlineDeliveryStorage.run(
        {
          startedAt: Date.now(),
          span: consumeSpan,
          sendStartedAt: params.callStartedAt,
        },
        () => hold.consume(handler)
      );
    }),
    (error) => {
      // The hold lapses and the queue delivers the message to the flow route;
      // the run's log is fenced against this delivery having written part of
      // it. Nothing to do here but say so.
      runtimeLogger.warn(
        'Inline delivery: the orchestrator delivery failed; the queue redelivers it',
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

/**
 * Starts the decision's {@link InlinePrewarm} for the message being sent, if
 * there is one and speculation is on. Never rejects: a failed speculation
 * only means the delivery prepares itself, as it would have anyway.
 */
function speculate(
  decision: Extract<InlineDecision, { inline: true }>,
  params: { message?: unknown; queueName?: string },
  span: Span | undefined
): {
  state: 'started' | 'disabled' | 'unavailable';
  /** Resolves with how long it took, `undefined` if it did not run. */
  done: Promise<number | undefined>;
} {
  if (process.env[INLINE_SPECULATION_ENV] === '0') {
    return { state: 'disabled', done: Promise.resolve(undefined) };
  }
  if (!decision.prewarm || params.queueName === undefined) {
    return { state: 'unavailable', done: Promise.resolve(undefined) };
  }
  const startedAt = Date.now();
  span?.setAttributes(Attribute.WorkflowInlineSpeculation('started'));
  let done: Promise<number | undefined>;
  try {
    done = decision.prewarm(params.message, params.queueName).then(
      () => Date.now() - startedAt,
      (error: unknown) => {
        runtimeLogger.debug(
          'Inline delivery: speculative preparation failed; the delivery prepares itself',
          { error: error instanceof Error ? error.message : String(error) }
        );
        return undefined;
      }
    );
  } catch {
    done = Promise.resolve(undefined);
  }
  return { state: 'started', done };
}
