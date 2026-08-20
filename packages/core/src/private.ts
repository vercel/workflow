/**
 * Utils used by the bundler when transforming code
 */

import { withResolvers } from '@workflow/utils';
import type { WorldCapabilities } from '@workflow/world';
import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import type { ReplayPayloadCache } from './replay-payload-cache.js';
import type { Serializable } from './schemas.js';
import type { PayloadKey } from './serialization/encryption.js';

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
  /**
   * Increments when a suspension is accepted and on every retained-session
   * resume. STEP suspension signals capture it when scheduled and no-op if
   * it moved (see step.ts) — this drops same-boundary sibling signals and
   * timers queued at boundary N that would fire after the session resumed
   * into boundary N+1. Sleep/hook/attribute signals are intentionally
   * unguarded: their presence makes the boundary unretainable, so a late
   * signal correctly demotes the session (workflow.ts `onWorkflowError`).
   */
  suspensionGeneration: number;
  eventsConsumer: EventsConsumer;
  /**
   * Map of pending invocations keyed by correlationId.
   * Using Map instead of Array for O(1) lookup/delete operations.
   */
  invocationsQueue: Map<string, QueueItem>;
  onWorkflowError: (error: Error) => void;
  /**
   * Mints the ULID body of a correlation id. `scope` identifies the *call site*
   * — what entity is being created, e.g. a step name plus an argument
   * fingerprint — and is combined with a per-scope invocation counter. Under the
   * positional scheme the scope is ignored (see `correlation-id.ts`), so every
   * call site passes one regardless: an id is then an ordinal over the whole
   * run and both replays of a run must draw in the same order.
   */
  generateUlid: (scope?: string) => string;
  generateNanoid: () => string;
  /**
   * Mints a hook token for a hook whose token the caller did not pin. Derived
   * from the hook's correlation id under the call-site scheme, drawn from the
   * run's shared PRNG stream under the positional one.
   */
  generateHookToken: (correlationId: string) => string;
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
  /**
   * Retire this entry: resolve `delivered` and remove it from the registry,
   * exactly as `markDelivered` would. Called only by the context's safety-net
   * dispenser ({@link ensureBarrierSafetyNet}), and only on the lowest-index
   * entry at delivery idle. Idempotent.
   */
  retire: () => void;
}

/**
 * Which earlier kinds each delivery kind defers behind. Chosen so that no kind
 * blocks on a peer it does not need to:
 *
 *  - a hook defers behind earlier HOOKS, WAITS and STEPS;
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
  hook: ['hook', 'wait', 'step'],
  wait: ['hook', 'step'],
  step: ['wait', 'hook', 'step'],
};

/**
 * Whether a delivery of `kind` at log index `index` gates on the earlier
 * registry entry `other` (at `otherIndex`).
 *
 * Single source of truth for that question, called by both
 * {@link awaitEarlierDeliveries} (which awaits what it gates on) and
 * {@link computeResolvesOnItsOwn} (which recurses into what it gates on).
 * Those two MUST agree exactly, and the doc block on
 * {@link awaitEarlierDeliveries} stakes deadlock-freedom on it, so the
 * condition lives here rather than being spelled out twice.
 */
function gatesOn(
  kind: DeliveryKind,
  index: number,
  otherIndex: number,
  other: DeliveryBarrierEntry
): boolean {
  if (otherIndex >= index || !DEFER_BEHIND[kind].includes(other.kind)) {
    return false;
  }
  // A step skips an UNARMED earlier entry (an unclaimed buffered hook
  // payload) — see the asymmetry described on `awaitEarlierDeliveries`. The
  // skip is direct, never transitive: armed entries are still gated on, even
  // when they are themselves parked behind such a payload.
  return !(kind === 'step' && !other.armed);
}

/**
 * Whether `entry` will resolve on its own — it is armed, and every earlier
 * delivery it actually gates on ({@link gatesOn}) will likewise resolve on its
 * own.
 *
 * A step does not gate on an unclaimed buffered payload, so such a payload
 * cannot keep it from resolving. A step DOES gate on earlier armed waits and
 * hooks, so one parked behind an unclaimed payload makes the step
 * non-self-resolving in turn. Disagreeing with {@link awaitEarlierDeliveries}
 * here would not be a cosmetic problem: this predicate is what
 * {@link hasParkedCommittedDelivery} uses to decide whether idle is reachable,
 * and an entry reported self-resolving while it is in fact parked behind a
 * payload that only the idle safety net can retire would gate its own
 * retirement.
 *
 * Recursion terminates because every edge points to a strictly smaller index.
 * `memo` keeps the walk linear in registry size, and the registry is not small
 * by construction — `EventsConsumer` drains consecutively consumable events
 * synchronously while barriers only retire on microtask-driven deliveries, so
 * a fan-out of `Promise.race([hook, sleep])` branches accumulates one barrier
 * per branch per kind. The memo MUST be per-call: `armed` mutates between
 * calls as buffered payloads are claimed.
 *
 * The memo is an optimization, not a correctness requirement. It once was one:
 * `awaitEarlierDeliveries` used to run this walk for every earlier entry of a
 * step delivery, with no early exit, which unmemoized is T(n) = Σ T(j) —
 * measured at 4.3e8 recursive calls (84s) for 40 alternating armed hook/wait
 * barriers. That call site is gone; a step now tests `armed` directly. The one
 * surviving caller, {@link hasParkedCommittedDelivery}, cannot reach that
 * shape: it returns at the FIRST self-resolving entry, so it only ever
 * advances past entries that are non-self-resolving, and those short-circuit
 * on their first false child. Every entry it evaluates therefore has
 * all-false predecessors and returns after one child, degenerating the walk to
 * a chain (measured: 98 calls unmemoized for the worst 40-barrier shape, 1
 * call for the registry above). Do not restore an exponential claim here
 * without restoring a caller that can produce it.
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
  for (const [otherIndex, other] of barriers) {
    if (!gatesOn(entry.kind, index, otherIndex, other)) {
      continue;
    }
    if (!resolvesOnItsOwn(barriers, otherIndex, other, memo)) {
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
 * What counts as "defers behind" is {@link gatesOn}, shared with
 * {@link computeResolvesOnItsOwn} so the two cannot drift.
 *
 * One asymmetry: a STEP result skips any earlier delivery that is UNARMED,
 * i.e. a buffered hook payload no consumer has claimed. Such a payload is
 * delivered only when the workflow next reads the hook, and reaching that read
 * very commonly requires the step result itself (`await stepX()` before the
 * read). Gating the step on it would stall the workflow until the barrier's
 * idle safety net fires, which then releases every delivery queued behind that
 * payload at once — losing exactly the race this ordering exists to protect.
 * Waits and hooks keep gating on unclaimed payloads: for them, waiting for the
 * claim IS the ordering guarantee (a `wait_completed` must not preempt a
 * payload the log ordered first).
 *
 * The skip is direct, never transitive. A step still gates on an earlier ARMED
 * wait or hook, including one that is itself parked behind an unclaimed
 * payload. Skipping those too would invert log order for the commonest shape
 * there is: a workflow that creates a hook it does not read on this branch,
 * races `step` against `sleep`, and has the log say the sleep won. The step
 * would then overtake the wait, both branches would swap the correlation ids
 * they draw next, and replay would diverge — see
 * `step-delivery-ordering.test.ts`. Waiting instead is safe because the
 * payload's own idle safety net retires it and the whole chain then delivers
 * in log order; {@link hasParkedCommittedDelivery} deliberately reports such a
 * step as not self-resolving so that idle stays reachable.
 *
 * "The whole chain then delivers in log order" rests on the PAYLOAD's barrier
 * being retired before that of anything parked behind it. That order is
 * structural: safety-net retirements go through one per-context dispenser that
 * only ever retires the lowest-index entry at delivery idle, and every
 * retirement that wakes a chain flips {@link hasParkedCommittedDelivery} back
 * to true, re-blocking the dispenser until the chain has drained — see
 * {@link ensureBarrierSafetyNet}. (This used to rest on the FIFO of one idle
 * poll per barrier, which held for a single parked segment but decayed to
 * timing noise with several — the release order, and therefore the ULIDs
 * drawn by the woken branches, then depended on how much log the replay had
 * loaded. storm-log-replay.test.ts replays a production log corrupted exactly
 * that way.)
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
  const earlier: Promise<void>[] = [];
  for (const [index, entry] of barriers) {
    if (!gatesOn(kind, eventIndex, index, entry)) {
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
 *
 * INVARIANT required of every call site: a barrier that is ever `armed` must
 * be paired with a delivery chain that runs unconditionally — attached when
 * the event is consumed (waits, step results, waiting-consumer hook payloads,
 * aborts), or by the `claim()` whose invocation is what arms it (buffered
 * hook payloads). The idle check ({@link scheduleWhenIdle}) refuses to
 * observe idle while an armed, self-resolving barrier is undelivered, and the
 * safety net below is itself idle-gated — so an armed barrier with no
 * unconditional chain would livelock every idle check in the run, including
 * its own retirement.
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

  const entry: DeliveryBarrierEntry = {
    kind,
    delivered: promise,
    armed: options.armed ?? true,
    retire: finish,
  };
  barriers.set(eventIndex, entry);

  // Safety net: if this delivery is never delivered to the workflow (its
  // branch was not taken / the run is suspending, or a buffered hook payload
  // is only claimed after a later delivery the workflow is still waiting on),
  // it is retired at idle so a later delivery gated on it cannot deadlock and
  // the registry cannot leak an entry per abandoned delivery. Retirement goes
  // through the context's single ordered dispenser rather than a per-barrier
  // idle poll — see {@link ensureBarrierSafetyNet} for why the ORDER of these
  // retirements is load-bearing.
  ensureBarrierSafetyNet(ctx);

  return {
    markDelivered: finish,
    arm: () => {
      entry.armed = true;
    },
  };
}

/**
 * Contexts whose barrier safety-net dispenser is currently armed. Module-level
 * so the context interface (constructed literally by many test harnesses)
 * needs no new field; entries drop with the context.
 */
const activeBarrierSafetyNets = new WeakSet<WorkflowOrchestratorContext>();

/**
 * The barrier registry's safety net: ONE idle-gated dispenser per context that
 * retires, at each observation of delivery idle, only the LOWEST-index entry
 * still registered, then yields so the chain it released can run before the
 * next retirement is considered.
 *
 * Why one ordered dispenser and not a poll per barrier (which is what this
 * replaced): the order of safety-net retirements decides the delivery order of
 * every chain parked behind an unclaimed buffered hook payload — a hook the
 * workflow never reads (a fire-and-forget `createHook`) parks every later
 * armed wait/hook behind a barrier that only this net can retire. Per-barrier
 * polls fire in whatever order their re-arm cycles land, and each re-arm
 * attaches to a `promiseQueue` that grows between checks, so with several
 * parked segments the release order decays to timing noise. Draws (`useStep`
 * correlation ids) then depend on which segment happened to release first —
 * concretely, on how MUCH log the replay loaded, since that decides what is in
 * the registry. That is the mechanism behind slot-mode CORRUPTED_EVENT_LOG on
 * storm-shaped runs (see storm-log-replay.test.ts, built from a production
 * log): two replays of the same run holding different-length prefixes bound
 * the same correlation ordinal to different steps.
 *
 * Retiring lowest-first is not merely tidy, it is the only order that cannot
 * invert the log: every gate points from a higher index to a strictly lower
 * one, so at delivery idle the lowest undelivered entry gates on nothing
 * still registered — it is the head of every parked chain (in practice, the
 * unclaimed payload itself). Releasing it lets the chain above deliver
 * through the ordinary barrier order; anything the release wakes flips
 * {@link hasParkedCommittedDelivery} back to true, which re-blocks this
 * dispenser until the chain has fully drained. A higher entry must never be
 * retired while a lower one is registered — that is exactly the inversion
 * described on {@link awaitEarlierDeliveries}.
 *
 * The dispenser goes dormant when the registry empties and is re-armed by the
 * next registration, so an idle context holds no live timer.
 */
function ensureBarrierSafetyNet(ctx: WorkflowOrchestratorContext): void {
  const barriers = ctx.pendingDeliveryBarriers;
  if (!barriers || activeBarrierSafetyNets.has(ctx)) {
    return;
  }
  activeBarrierSafetyNets.add(ctx);
  const rearm = () => {
    setTimeout(check, 0);
  };
  // A rejected promiseQueue settles immediately and forever, so re-arming
  // through it at the normal cadence would degenerate into a busy loop on an
  // abandoned context. Back off instead: correctness only needs the dispenser
  // to still exist, since the registry gates suspension via isDeliveryIdle
  // and a dead dispenser would wedge the run.
  const rearmAfterRejection = () => {
    setTimeout(check, 50);
  };
  const check = () => {
    if (barriers.size === 0) {
      // Dormant. The next registerDeliveryBarrier re-arms.
      activeBarrierSafetyNets.delete(ctx);
      return;
    }
    if (!canRetireAbandonedBarriers(ctx)) {
      // A delivery is hydrating or committed-but-parked on its deferral; let
      // the queue drain and re-check a tick later (same cadence as
      // scheduleWhenIdle).
      ctx.promiseQueue.then(rearm, rearmAfterRejection);
      return;
    }
    // Idle with entries left: nothing remaining delivers on its own, so
    // release parked chains from the head — lowest index first, one at a
    // time, re-reading idle between retirements. A retirement that wakes a
    // chain flips {@link hasParkedCommittedDelivery} synchronously (it is
    // computed from the registry this loop just mutated), which stops the
    // sweep so the chain delivers before anything above it is released. A
    // retirement that wakes nothing (a stale payload no delivery gates on)
    // keeps the sweep going, so a backlog of those drains in ONE idle
    // observation — pacing them one per timer tick would hold consumed-but-
    // undelivered events hostage long enough to trip the events consumer's
    // unconsumed-event deadline and fail healthy replays.
    while (barriers.size > 0 && canRetireAbandonedBarriers(ctx)) {
      let lowestIndex: number | undefined;
      let lowestEntry: DeliveryBarrierEntry | undefined;
      for (const [index, entry] of barriers) {
        if (lowestIndex === undefined || index < lowestIndex) {
          lowestIndex = index;
          lowestEntry = entry;
        }
      }
      lowestEntry?.retire();
    }
    setTimeout(check, 0);
  };
  setTimeout(check, 0);
}

/**
 * Whether the safety-net dispenser may retire abandoned barriers right now:
 * no hydration in flight and no committed delivery still working through its
 * detached deferral. This is deliberately WEAKER than {@link isDeliveryIdle}:
 * the dispenser is what empties the registry, so gating it on registry
 * emptiness would gate its own work.
 */
function canRetireAbandonedBarriers(ctx: WorkflowOrchestratorContext): boolean {
  return ctx.pendingDeliveries === 0 && !hasParkedCommittedDelivery(ctx);
}

/**
 * Whether some registered branch-deciding delivery is going to reach the
 * workflow without any further help (it is armed and not transitively parked
 * behind an unclaimed buffered payload — see {@link resolvesOnItsOwn}) but
 * has not been handed over yet.
 *
 * This is the delivery state `pendingDeliveries` cannot see. That counter
 * covers the hydration window inside a serial `promiseQueue` slot and is
 * released there, while the delivery's `resolve()` runs later, from a
 * detached continuation behind {@link awaitEarlierDeliveries} — including its
 * macrotask yield whenever the delivery had to defer. Replaying a batch of N
 * parallel step results consumed in one drain window leaves N-1 of them
 * parked on that yield with `pendingDeliveries` already at 0. An idle check
 * armed during the same window (a pending `sleep()` arms one on every replay)
 * could then observe "idle" mid-deferral and raise a `WorkflowSuspension`
 * BEFORE the workflow's own continuations ran — a suspension carrying none of
 * the follow-up work the batch was about to create, which the runtime
 * dutifully schedules as nothing, leaving the run dormant until an unrelated
 * timer fires (vercel/workflow#3183).
 *
 * Deliveries that do NOT resolve on their own must be excluded, not for
 * accuracy but for termination: an unclaimed buffered hook payload is retired
 * BY the idle safety net in {@link registerDeliveryBarrier}, so counting it
 * here would gate its own retirement. That reasoning extends to whatever is
 * parked behind such a payload — a wait, and a step gating on that wait — for
 * the same reason: the whole chain moves only once the net fires, and it
 * cannot fire while the chain is counted. Self-resolving deliveries always
 * deliver from their own chains (see the INVARIANT on
 * {@link registerDeliveryBarrier}) and never need that net, so waiting on
 * them is deadlock-free.
 */
export function hasParkedCommittedDelivery(
  ctx: WorkflowOrchestratorContext
): boolean {
  const barriers = ctx.pendingDeliveryBarriers;
  if (!barriers || barriers.size === 0) {
    return false;
  }
  // Shared across this call only — see `resolvesOnItsOwn`.
  const selfResolving = new Map<number, boolean>();
  for (const [index, entry] of barriers) {
    if (resolvesOnItsOwn(barriers, index, entry, selfResolving)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether no data delivery (step result, hook payload) is in flight right now.
 *
 * "In flight" is two distinct windows, each with its own guard:
 * `pendingDeliveries > 0` covers hydration inside the serial queue slots, and
 * {@link hasParkedCommittedDelivery} covers the detached gap between a slot
 * releasing that counter and the delivery's `resolve()` actually running —
 * deliberately outside `pendingDeliveries` (see step.ts), and invisible to it.
 *
 * Anything that decides a replay is over, or that a replay went wrong, has to
 * consult this first: while it is false the workflow VM is mid-reaction, so
 * what it has and has not done yet says nothing about the run. Two callers
 * read it, for the two such decisions: {@link scheduleWhenIdle} for the
 * suspension, and the events consumer's unconsumed-event check for divergence.
 *
 * A non-empty barrier registry counts as in flight, even when every remaining
 * entry is parked behind an unclaimed buffered payload. Those entries only
 * move when the safety-net dispenser retires them (lowest-first, see
 * {@link ensureBarrierSafetyNet}), and the deliveries they release are real
 * workflow reactions — a suspension raised before they run would be computed
 * from a VM that has not seen them, scheduling none of their follow-up work
 * and leaving the run dormant (the vercel/workflow#3183 shape). The dispenser
 * itself is gated on {@link canRetireAbandonedBarriers}, the weaker predicate
 * without the registry term, precisely so it can do the draining that this
 * predicate waits for; registry size strictly decreases at each retirement,
 * so idle is always reached.
 */
export function isDeliveryIdle(ctx: WorkflowOrchestratorContext): boolean {
  return (
    ctx.pendingDeliveries === 0 &&
    (!ctx.pendingDeliveryBarriers || ctx.pendingDeliveryBarriers.size === 0)
  );
}

/**
 * Schedule a callback to fire only after all pending data deliveries
 * (step results, hook payloads) and async deserialization have completed.
 * Uses a polling loop: setTimeout(0) → check pendingDeliveries and the
 * barrier registry → if anything is still in flight, wait for promiseQueue →
 * repeat. This handles the multi-round delivery pattern where each hook
 * payload delivery cycle appends new async work to the promiseQueue. What
 * counts as in flight is {@link isDeliveryIdle}.
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
    if (!isDeliveryIdle(ctx)) {
      // A delivery is still hydrating, or is committed but parked behind its
      // deferral (whose resolve runs on a detached timer, not this queue).
      // Either way: let the queue drain, then re-check a timer tick later.
      ctx.promiseQueue.then(() => {
        setTimeout(check, 0);
      });
    } else {
      fn();
    }
  };
  setTimeout(check, 0);
}
