/**
 * Utils used by the bundler when transforming code
 */

import { withResolvers } from '@workflow/utils';
import type { CryptoKey } from './encryption.js';
import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import type { Serializable } from './schemas.js';

export type StepFunction<
  Args extends Serializable[] = any[],
  Result extends Serializable | unknown = unknown,
> = ((...args: Args) => Promise<Result>) & {
  maxRetries?: number;
  stepId?: string;
};

const RegisteredStepsKey = Symbol.for('@workflow/core//registeredSteps');

const globalSymbols: typeof globalThis & {
  [RegisteredStepsKey]?: Map<string, StepFunction>;
} = globalThis;

// biome-ignore lint/suspicious/noAssignInExpressions: /
const registeredSteps = (globalSymbols[RegisteredStepsKey] ??= new Map<
  string,
  StepFunction
>());

const BUILTIN_RESPONSE_STEP_NAMES = new Set([
  '__builtin_response_array_buffer',
  '__builtin_response_json',
  '__builtin_response_text',
]);

function getStepIdAliasCandidates(stepId: string): string[] {
  const parts = stepId.split('//');
  if (parts.length !== 3 || parts[0] !== 'step') {
    return [];
  }

  const modulePath = parts[1];
  const fnName = parts[2];
  const modulePathAliases = new Set<string>();

  const addAlias = (aliasModulePath: string) => {
    if (aliasModulePath !== modulePath) {
      modulePathAliases.add(aliasModulePath);
    }
  };

  if (modulePath.startsWith('./workflows/')) {
    const workflowRelativePath = modulePath.slice('./'.length);
    addAlias(`./example/${workflowRelativePath}`);
    addAlias(`./src/${workflowRelativePath}`);
  } else if (modulePath.startsWith('./example/workflows/')) {
    const workflowRelativePath = modulePath.slice('./example/'.length);
    addAlias(`./${workflowRelativePath}`);
    addAlias(`./src/${workflowRelativePath}`);
  } else if (modulePath.startsWith('./src/workflows/')) {
    const workflowRelativePath = modulePath.slice('./src/'.length);
    addAlias(`./${workflowRelativePath}`);
    addAlias(`./example/${workflowRelativePath}`);
  }

  return Array.from(
    modulePathAliases,
    (aliasModulePath) => `step//${aliasModulePath}//${fnName}`
  );
}

function getBuiltinResponseStepAlias(stepId: string): StepFunction | undefined {
  if (!BUILTIN_RESPONSE_STEP_NAMES.has(stepId)) {
    return undefined;
  }

  for (const [registeredStepId, stepFn] of registeredSteps.entries()) {
    if (registeredStepId.endsWith(`//${stepId}`)) {
      return stepFn;
    }
  }

  return undefined;
}

/**
 * Register a step function to be served in the server bundle.
 * Also sets the stepId property on the function for serialization support.
 *
 * Note: The SWC compiler plugin no longer generates calls to this function.
 * Step registration is now inlined as a self-contained IIFE that writes
 * directly to the global Map at Symbol.for("@workflow/core//registeredSteps").
 * This function is kept for internal/test use only.
 */
export function registerStepFunction(stepId: string, stepFn: StepFunction) {
  registeredSteps.set(stepId, stepFn);
  stepFn.stepId = stepId;
}

/**
 * Find a registered step function by name
 */
export function getStepFunction(stepId: string): StepFunction | undefined {
  const directMatch = registeredSteps.get(stepId);
  if (directMatch) {
    return directMatch;
  }

  // Support equivalent workflow path aliases in mixed symlink environments.
  for (const aliasStepId of getStepIdAliasCandidates(stepId)) {
    const aliasMatch = registeredSteps.get(aliasStepId);
    if (aliasMatch) {
      return aliasMatch;
    }
  }

  const builtinAliasMatch = getBuiltinResponseStepAlias(stepId);
  if (builtinAliasMatch) {
    return builtinAliasMatch;
  }

  return undefined;
}

// Note: __private_getClosureVars is no longer re-exported here.
// The SWC compiler plugin now inlines closure variable access as a
// self-contained IIFE that reads directly from the global AsyncLocalStorage
// at Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE").

export interface WorkflowOrchestratorContext {
  runId: string;
  encryptionKey: CryptoKey | undefined;
  globalThis: typeof globalThis;
  eventsConsumer: EventsConsumer;
  /**
   * Map of pending invocations keyed by correlationId.
   * Using Map instead of Array for O(1) lookup/delete operations.
   */
  invocationsQueue: Map<string, QueueItem>;
  onWorkflowError: (error: Error) => void;
  generateUlid: () => string;
  generateNanoid: () => string;
  /**
   * Sequential promise queue that ensures all event-driven promise resolutions
   * (step results, hook payloads, failures, suspensions) happen in event log
   * order. Every resolve, reject, or workflow error is chained through this
   * queue so that even if individual operations take variable time (e.g.,
   * async decryption), promises resolve deterministically.
   */
  promiseQueue: Promise<void>;
  /**
   * Counter of in-flight async data delivery operations (step result
   * hydration, hook payload hydration). Suspensions must wait for this
   * to reach 0 before firing, to avoid preempting data delivery.
   */
  pendingDeliveries: number;
  /**
   * Ordered registry of in-flight "branch-deciding" deliveries — the
   * resolutions a workflow typically `Promise.race`s on: buffered hook
   * payloads (`hook_received`) and wait completions (`wait_completed`).
   * Keyed by the delivery's position (index) in the consumed event log.
   *
   * The problem: a buffered hook payload is observed via the async hook
   * iterator (`yield await this`), costing extra microtask hops, while a
   * `wait_completed` resolves with fewer hops — and a reused sleep can
   * resolve in an entirely earlier loop iteration. Either way, the
   * resolution that the committed event log ordered first can lose a
   * `Promise.race` to a faster- or already-resolved competitor, diverging
   * from the log and surfacing as `CorruptedEventLogError`.
   *
   * The fix is a strict, deterministic delivery order anchored on
   * event-log position: a delivery does not resolve to the workflow until
   * every earlier-in-log delivery of the OPPOSITE kind has been delivered.
   * (Opposite kind only: sequential same-kind hook payloads must not block
   * one another, and a wait need not wait behind a later wait.) Because the
   * gate is "the earlier delivery resolved", not "won a timing race", the
   * outcome is independent of microtask hops, hydration/decryption time,
   * and `Promise.race` argument order.
   *
   * Index is used rather than the `eventId` string because `eventId` is an
   * opaque, world-assigned value not guaranteed to sort in creation order
   * (only the bundled ULID worlds happen to).
   *
   * Optional so older/out-of-tree contexts (and lightweight test harnesses)
   * that do not initialize it degrade gracefully to the previous behavior.
   */
  pendingDeliveryBarriers?: Map<number, DeliveryBarrierEntry>;
}

/** The kind of branch-deciding delivery a barrier represents. */
export type DeliveryKind = 'hook' | 'wait';

interface DeliveryBarrierEntry {
  kind: DeliveryKind;
  /** Resolves once this delivery has resolved to the workflow. */
  delivered: Promise<void>;
}

/**
 * Awaits, in strict event-log order, every still-registered delivery whose
 * index is earlier than `eventIndex` AND whose kind is in `deferBehindKinds`,
 * so that this resolution is handed to the workflow only after all relevant
 * earlier-in-log deliveries have been. This is what keeps a `Promise.race`
 * deterministic and aligned with the committed event log, independent of
 * microtask-hop counts, hydration time, or race-argument order.
 *
 * `deferBehindKinds` is the opposite kind(s): a hook defers behind earlier
 * WAITS (not earlier hooks — those are sequential same-entity payloads), a
 * wait defers behind earlier HOOKS.
 */
export async function awaitEarlierDeliveries(
  ctx: WorkflowOrchestratorContext,
  eventIndex: number | undefined,
  deferBehindKinds: readonly DeliveryKind[]
): Promise<void> {
  // Defensive: tolerate contexts that predate this field (test harnesses).
  if (
    eventIndex === undefined ||
    !ctx.pendingDeliveryBarriers ||
    ctx.pendingDeliveryBarriers.size === 0
  ) {
    return;
  }
  const earlier: Promise<void>[] = [];
  for (const [index, entry] of ctx.pendingDeliveryBarriers) {
    if (index < eventIndex && deferBehindKinds.includes(entry.kind)) {
      earlier.push(entry.delivered);
    }
  }
  if (earlier.length > 0) {
    await Promise.all(earlier);
  }
}

/** Handle for a registered branch-deciding delivery barrier. */
export interface DeliveryBarrier {
  /**
   * Mark this delivery as delivered to the workflow. Resolves its
   * `delivered` promise so any later-in-log opposite-kind delivery gated on
   * it (via {@link awaitEarlierDeliveries}) may proceed, and removes it from
   * the registry. Idempotent.
   */
  markDelivered: () => void;
}

/**
 * Register a branch-deciding delivery at its event-log index so that later
 * opposite-kind deliveries can be ordered strictly after it. Returns an inert
 * handle when `pendingDeliveryBarriers` is not initialized.
 *
 * To guarantee a later delivery gated on this one can never hang when this
 * delivery is abandoned (the workflow took a different branch or is
 * suspending and never observes it), the barrier auto-resolves at idle.
 */
export function registerDeliveryBarrier(
  ctx: WorkflowOrchestratorContext,
  eventIndex: number | undefined,
  kind: DeliveryKind
): DeliveryBarrier {
  const barriers = ctx.pendingDeliveryBarriers;
  if (!barriers || eventIndex === undefined) {
    return { markDelivered: () => {} };
  }

  let done = false;
  const { promise, resolve } = withResolvers<void>();
  const entry: DeliveryBarrierEntry = { kind, delivered: promise };
  barriers.set(eventIndex, entry);

  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    if (barriers.get(eventIndex) === entry) {
      barriers.delete(eventIndex);
    }
    resolve();
  };

  // Safety net: if this delivery is never delivered to the workflow (its
  // branch was not taken / the run is suspending), resolve at idle so a
  // later opposite-kind delivery gated on it cannot deadlock and the
  // registry cannot leak an entry per abandoned delivery.
  scheduleWhenIdle(ctx, finish);

  return { markDelivered: finish };
}

/**
 * Schedule a callback to fire only after all pending data deliveries
 * (step results, hook payloads) and async deserialization have completed.
 * Uses a polling loop: setTimeout(0) → check pendingDeliveries →
 * if > 0, wait for promiseQueue → repeat. This handles the multi-round
 * delivery pattern where each hook payload delivery cycle appends new
 * async work to the promiseQueue.
 *
 * The initial `setTimeout(0)` macrotask is load-bearing and must NOT be
 * downgraded to a microtask (`queueMicrotask`/`Promise.resolve().then`).
 * `pendingDeliveries` only guards the host-side hydration window; between a
 * delivery's `resolve()` and the workflow VM body running its continuation to
 * register the next subscriber, `pendingDeliveries` is already 0 even though
 * the VM is mid-reaction. Node does not guarantee a microtask scheduled in
 * the host context settles after the cross-VM promise chain (resolve in host
 * → workflow code in VM → subscribe back in host); the macrotask boundary
 * gives that chain time to run, so the suspension does not preempt a sibling
 * delivery still in flight. Empirically, replacing it with `queueMicrotask`
 * breaks hook/sleep `Promise.race` ordering (CorruptedEventLogError).
 */
export function scheduleWhenIdle(
  ctx: WorkflowOrchestratorContext,
  fn: () => void
): void {
  const check = () => {
    if (ctx.pendingDeliveries > 0) {
      // Still delivering data — wait for queue to drain, then re-check
      ctx.promiseQueue.then(() => {
        setTimeout(check, 0);
      });
    } else {
      fn();
    }
  };
  setTimeout(check, 0);
}
