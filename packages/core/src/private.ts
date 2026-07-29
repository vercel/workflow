/**
 * Utils used by the bundler when transforming code
 */

import { withResolvers } from '@workflow/utils';
import type { WorldCapabilities } from '@workflow/world';
import type { PayloadKey } from './serialization/encryption.js';
import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import type { ReplayPayloadCache } from './replay-payload-cache.js';
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
  encryptionKey: PayloadKey | undefined;
  worldCapabilities?: WorldCapabilities;
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
   * hydration, hook payload hydration, abort signal hydration). Suspensions
   * must wait for this to reach 0 before firing, to avoid preempting data
   * delivery — e.g. dehydrating a step's arguments while an abort that should
   * be reflected in those arguments is still hydrating its reason.
   */
  pendingDeliveries: number;
  /**
   * Ordered registry of in-flight "branch-deciding" deliveries — the
   * resolutions a workflow typically `Promise.race`s on, or awaits from
   * independent concurrent branches: hook payloads (`hook_received`), wait
   * completions (`wait_completed`), and step results (`step_completed` /
   * `step_failed`). Keyed by the delivery's position (index) in the consumed
   * event log.
   *
   * The problem: each of these resolutions reaches workflow code after a
   * different, workload-dependent number of microtask hops. A buffered hook
   * payload is observed via the async hook iterator (`yield await this`),
   * costing extra hops; a `wait_completed` resolves with fewer, and a reused
   * sleep can resolve in an entirely earlier loop iteration; a step result is
   * gated on hydration whose cost varies between replays of the SAME
   * invocation — the first replay pays the full decrypt/decompress/revive,
   * while later replays sharing the invocation's `ReplayPayloadCache`
   * memo-hit small primitive results and resolve in one or two hops. Either
   * way, the resolution that the committed event log ordered first can lose a
   * `Promise.race` (or a `useStep` ULID allocation) to a faster- or
   * already-resolved competitor, diverging from the log and surfacing as
   * `CorruptedEventLogError`.
   *
   * The fix is a strict, deterministic delivery order anchored on
   * event-log position: a delivery does not resolve to the workflow until
   * every relevant earlier-in-log delivery has been delivered. Because the
   * gate is "the earlier delivery resolved", not "won a timing race", the
   * outcome is independent of microtask hops, hydration/decryption time,
   * and `Promise.race` argument order. Which earlier kinds a delivery defers
   * behind is spelled out on {@link awaitEarlierDeliveries}.
   *
   * Index is used rather than the `eventId` string because `eventId` is an
   * opaque, world-assigned value not guaranteed to sort in creation order
   * (only the bundled ULID worlds happen to).
   *
   * Optional so older/out-of-tree contexts (and lightweight test harnesses)
   * that do not initialize it degrade gracefully to the previous behavior.
   */
  pendingDeliveryBarriers?: Map<number, DeliveryBarrierEntry>;
  /**
   * Invocation-scoped cache of prepared serialized payloads and immutable final
   * values. Prepared bytes survive fresh replay VMs; object graphs do not.
   */
  replayPayloadCache: ReplayPayloadCache;
}

/** The kind of branch-deciding delivery a barrier represents. */
export type DeliveryKind = 'hook' | 'wait' | 'step';

interface DeliveryBarrierEntry {
  kind: DeliveryKind;
  /** Resolves once this delivery has resolved to the workflow. */
  delivered: Promise<void>;
  /**
   * Whether this delivery is committed to reaching the workflow without any
   * further action by workflow code. True for wait completions and step
   * results, which always resolve from their own chain, and for a hook payload
   * that already had a waiting consumer when it was consumed.
   *
   * False for a BUFFERED hook payload no consumer has claimed yet: it is
   * delivered by `claim()`, i.e. whenever the workflow next reads the hook —
   * which may be causally *after* a later-in-log delivery. `arm()` flips it
   * once a consumer takes the payload.
   */
  armed: boolean;
}

/**
 * Which earlier kinds each delivery kind defers behind. Chosen so that no kind
 * blocks on a peer it does not need to:
 *
 *  - a hook defers behind earlier WAITS and STEPS — not earlier hooks, which
 *    are sequential same-entity payloads and must not block one another;
 *  - a wait defers behind earlier HOOKS and STEPS — not earlier waits, since a
 *    wait never needs to queue behind another wait;
 *  - a step defers behind earlier WAITS, HOOKS and STEPS.
 *
 * The step-behind-step edge is not redundant with the serial `promiseQueue`.
 * The queue fixes the order in which step results are HYDRATED, but a step no
 * longer resolves inside its queue slot — it captures the outcome there and
 * resolves from a detached continuation once its barrier clears. Two steps
 * agree on that continuation's ordering only while they defer behind the same
 * set, which holds when they are consumed in the same drain window but not
 * across windows: a step consumed later can miss a wait/hook barrier that an
 * earlier step is still parked on, because the barrier retired in between. The
 * earlier step is then waiting out the macrotask yield below while the later
 * one resolves on microtasks, and overtakes it — see
 * `delivery-barrier-coverage.test.ts`. Deferring behind earlier steps
 * closes that window structurally: the earlier step's barrier is still
 * registered precisely because it has not delivered yet.
 *
 * Every edge points from a later log index to a strictly earlier one, so the
 * wait-for graph can never contain a cycle.
 */
const DEFER_BEHIND: Record<DeliveryKind, readonly DeliveryKind[]> = {
  hook: ['wait', 'step'],
  wait: ['hook', 'step'],
  step: ['wait', 'hook', 'step'],
};

/**
 * Whether `entry` will resolve on its own — it is armed, and every earlier
 * delivery it defers behind will likewise resolve on its own.
 *
 * A step delivery is always self-resolving: it skips uncommitted deliveries
 * (see {@link awaitEarlierDeliveries}), and the earlier steps it does defer
 * behind are self-resolving by the same argument, inducting down on index.
 *
 * Recursion terminates because every edge points to a strictly smaller index.
 * `memo` is required rather than an optimization: without it the walk is
 * exponential in the number of live hook/wait barriers (each armed entry
 * re-walks every earlier entry of the opposite kind, T(n) = Σ T(j)), and the
 * registry is not small by construction — `EventsConsumer` drains
 * consecutively consumable events synchronously while barriers only retire on
 * microtask-driven deliveries, so a fan-out of `Promise.race([hook, sleep])`
 * branches accumulates one barrier per branch per kind. Memoized, the walk is
 * linear in registry size. The memo MUST be per-call: `armed` mutates between
 * calls as buffered payloads are claimed.
 */
function resolvesOnItsOwn(
  barriers: Map<number, DeliveryBarrierEntry>,
  index: number,
  entry: DeliveryBarrierEntry,
  memo: Map<number, boolean>
): boolean {
  const cached = memo.get(index);
  if (cached !== undefined) {
    return cached;
  }
  const result = computeResolvesOnItsOwn(barriers, index, entry, memo);
  memo.set(index, result);
  return result;
}

function computeResolvesOnItsOwn(
  barriers: Map<number, DeliveryBarrierEntry>,
  index: number,
  entry: DeliveryBarrierEntry,
  memo: Map<number, boolean>
): boolean {
  if (!entry.armed) {
    return false;
  }
  if (entry.kind === 'step') {
    return true;
  }
  const deferBehind = DEFER_BEHIND[entry.kind];
  for (const [otherIndex, other] of barriers) {
    if (
      otherIndex < index &&
      deferBehind.includes(other.kind) &&
      !resolvesOnItsOwn(barriers, otherIndex, other, memo)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Awaits, in strict event-log order, every still-registered delivery that is
 * earlier in the log than `eventIndex` and that a delivery of `kind` defers
 * behind (see {@link DEFER_BEHIND}), so that this resolution is handed to the
 * workflow only after all relevant earlier-in-log deliveries have been. This
 * is what keeps a `Promise.race` — or the ULID a follow-up `useStep` draws on
 * a concurrent branch — deterministic and aligned with the committed event
 * log, independent of microtask-hop counts, hydration time, or race-argument
 * order. When this delivery does have to wait, it also yields a macrotask
 * afterwards so the earlier delivery's consumer can run to its own next
 * suspension point first; see the comment at that `await` for why ordering the
 * `resolve()` calls alone is not enough.
 *
 * One asymmetry: a STEP result additionally skips any earlier delivery that
 * will not resolve on its own, i.e. one blocked (directly or transitively) on
 * a buffered hook payload no consumer has claimed. Such a payload is delivered
 * only when the workflow next reads the hook, and reaching that read very
 * commonly requires the step result itself (`await stepX()` before the read).
 * Gating the step on it would stall the workflow until the barrier's idle
 * safety net fires, which then releases every delivery queued behind that
 * payload at once — losing exactly the race this ordering exists to protect.
 * Waits and hooks keep gating on unclaimed payloads: for them, waiting for the
 * claim IS the ordering guarantee (a `wait_completed` must not preempt a
 * payload the log ordered first).
 */
export async function awaitEarlierDeliveries(
  ctx: WorkflowOrchestratorContext,
  eventIndex: number | undefined,
  kind: DeliveryKind
): Promise<void> {
  // Defensive: tolerate contexts that predate this field (test harnesses).
  if (
    eventIndex === undefined ||
    !ctx.pendingDeliveryBarriers ||
    ctx.pendingDeliveryBarriers.size === 0
  ) {
    return;
  }
  const barriers = ctx.pendingDeliveryBarriers;
  const deferBehind = DEFER_BEHIND[kind];
  const earlier: Promise<void>[] = [];
  // Shared across this call only — see `resolvesOnItsOwn`.
  const selfResolving = new Map<number, boolean>();
  for (const [index, entry] of barriers) {
    if (index >= eventIndex || !deferBehind.includes(entry.kind)) {
      continue;
    }
    if (
      kind === 'step' &&
      !resolvesOnItsOwn(barriers, index, entry, selfResolving)
    ) {
      continue;
    }
    earlier.push(entry.delivered);
  }
  if (earlier.length > 0) {
    await Promise.all(earlier);
    // An earlier delivery being "delivered" only means its `resolve()` ran.
    // The branch it woke may need an arbitrary number of further microtask
    // hops before it reaches its next `useStep` call and draws a ULID — a
    // `for await` over a hook, for instance, resumes the generator, settles
    // the promise from `next()`, and only then runs the loop body. Resolving
    // this delivery on a microtask would let it overtake that branch and
    // reorder the ULID allocation anyway, turning the guarantee below into a
    // hop-count race that holds only for the shortest consumers.
    //
    // Yielding a macrotask lets the earlier branch's entire microtask chain
    // drain first, whatever its length, so log order survives regardless of
    // how the workflow consumes the earlier delivery. Only deliveries that
    // actually had to defer pay this, so the common single-delivery drain is
    // unaffected.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Handle for a registered branch-deciding delivery barrier. */
export interface DeliveryBarrier {
  /**
   * Mark this delivery as delivered to the workflow. Resolves its
   * `delivered` promise so any later-in-log delivery gated on it (via
   * {@link awaitEarlierDeliveries}) may proceed, and removes it from the
   * registry. Idempotent.
   */
  markDelivered: () => void;
  /**
   * Mark this delivery as committed to happening, for a barrier registered
   * unarmed (a buffered hook payload) once a consumer has claimed it. From
   * then on a later step result may be ordered behind it. Idempotent.
   */
  arm: () => void;
}

/**
 * Register a branch-deciding delivery at its event-log index so that later
 * deliveries can be ordered strictly after it. Returns an inert handle when
 * `pendingDeliveryBarriers` is not initialized.
 *
 * Pass `armed: false` for a delivery whose resolution waits on workflow code
 * asking for it (a buffered hook payload); call `arm()` when it does.
 *
 * To guarantee a later delivery gated on this one can never hang when this
 * delivery is abandoned (the workflow took a different branch or is
 * suspending and never observes it), the barrier auto-resolves at idle.
 */
export function registerDeliveryBarrier(
  ctx: WorkflowOrchestratorContext,
  eventIndex: number | undefined,
  kind: DeliveryKind,
  options: { armed?: boolean } = {}
): DeliveryBarrier {
  const barriers = ctx.pendingDeliveryBarriers;
  if (!barriers || eventIndex === undefined) {
    return { markDelivered: () => {}, arm: () => {} };
  }

  let done = false;
  const { promise, resolve } = withResolvers<void>();
  const entry: DeliveryBarrierEntry = {
    kind,
    delivered: promise,
    armed: options.armed ?? true,
  };
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
  // branch was not taken / the run is suspending, or a buffered hook payload
  // is only claimed after a later delivery the workflow is still waiting on),
  // resolve at idle so a later delivery gated on it cannot deadlock and the
  // registry cannot leak an entry per abandoned delivery.
  scheduleWhenIdle(ctx, finish);

  return {
    markDelivered: finish,
    arm: () => {
      entry.armed = true;
    },
  };
}

/**
 * Whether any registered branch-deciding delivery is committed to reaching
 * the workflow on its own (see {@link resolvesOnItsOwn}) but has not been
 * delivered yet. `pendingDeliveries` alone cannot see these: a delivery
 * releases that counter inside its serial queue slot, while its `resolve()`
 * runs from a detached continuation behind `awaitEarlierDeliveries` — which
 * ends with a macrotask yield whenever the delivery had to defer. For a
 * parallel batch of N step results consumed in one drain window, N-1 of them
 * are parked on that yield with `pendingDeliveries` already at 0, so an idle
 * check racing them can observe "idle" and raise a suspension that predates
 * the workflow's own continuation. The suspension then carries none of the
 * follow-up work the batch was about to queue, the runtime schedules
 * nothing, and the run goes dormant until an unrelated timer fires.
 *
 * Only deliveries that resolve on their own are counted: they always deliver
 * from their own detached chains (never needing the idle safety net in
 * {@link registerDeliveryBarrier}), so waiting for them cannot deadlock the
 * idle check. A barrier that does NOT resolve on its own — an unclaimed
 * buffered hook payload, or a delivery parked behind one — must not block
 * idle, because idle is exactly what retires it.
 */
function hasUndeliveredCommittedDeliveries(
  ctx: WorkflowOrchestratorContext
): boolean {
  const barriers = ctx.pendingDeliveryBarriers;
  if (!barriers || barriers.size === 0) {
    return false;
  }
  // Shared across this call only — see `resolvesOnItsOwn`.
  const memo = new Map<number, boolean>();
  for (const [index, entry] of barriers) {
    if (resolvesOnItsOwn(barriers, index, entry, memo)) {
      return true;
    }
  }
  return false;
}

/**
 * Schedule a callback to fire only after all pending data deliveries
 * (step results, hook payloads) and async deserialization have completed.
 * Uses a polling loop: setTimeout(0) → check pendingDeliveries and
 * committed-but-undelivered barriers → if any, wait for promiseQueue →
 * repeat. This handles the multi-round delivery pattern where each hook
 * payload delivery cycle appends new async work to the promiseQueue.
 *
 * `pendingDeliveries` guards the hydration window inside the serial queue
 * slots; {@link hasUndeliveredCommittedDeliveries} guards the detached
 * deferral window between a slot completing and the delivery's `resolve()`
 * actually running, which `pendingDeliveries` deliberately does not cover
 * (see step.ts for why it is released inside the slot).
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
    if (ctx.pendingDeliveries > 0 || hasUndeliveredCommittedDeliveries(ctx)) {
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
