/**
 * Utils used by the bundler when transforming code
 */

import type { CryptoKey } from './encryption.js';
import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import type { Serializable } from './schemas.js';

/**
 * Hard upper bound on how long suspension / unconsumed-event checks will wait
 * for `pendingVmWork` to drain before forcing a decision. The deterministic
 * counter (`pendingVmWork`) handles the common case; this watchdog is only a
 * safety net so a lost decrement (e.g. an exception in a delivery's microtask
 * chain that prevents the `pendingVmWork--` from running) doesn't hang the
 * run forever.
 *
 * Tuned conservatively: the previous wall-clock heuristic was 100 ms and
 * still missed real workflows. This isn't tuned to fit a specific workflow
 * shape — it's "much longer than any reasonable VM-side continuation."
 */
const VM_IDLE_WATCHDOG_MS = 5000;

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
   * hydration, hook payload hydration). Incremented when a delivery's
   * hydration begins; decremented in the same `finally` that calls
   * `resolve()`/`reject()` on the VM-visible promise. Reflects only the
   * host-side network/hydration window.
   */
  pendingDeliveries: number;
  /**
   * Counter of deliveries that have been resolved into the VM but whose
   * follow-up continuation work has not yet settled. Incremented at the
   * start of each delivery (alongside `pendingDeliveries`); decremented
   * one microtask AFTER `resolve()` runs, so the body's awaiting
   * continuation — including any synchronous `step()`/`subscribe()` calls
   * it makes in response — has executed before the decrement is observed.
   *
   * The host is only safe to suspend (or to declare an event "unconsumed")
   * when BOTH `pendingDeliveries === 0 AND pendingVmWork === 0`. The two
   * counters cover complementary windows of in-flight work:
   *
   *   `pendingDeliveries`: network / hydration in flight on the host
   *   `pendingVmWork`:     hydration completed, body's continuation pending
   *
   * Replaces the prior wall-clock heuristic (`REPLAY_PROPAGATION_DELAY_MS`
   * + `DEFERRED_CHECK_DELAY_MS`), which guessed at how long the VM-side
   * continuation would take. The counter measures it deterministically.
   */
  pendingVmWork: number;
  /**
   * Observers fired whenever the host transitions into the VM-idle state
   * (both counters at 0 after a decrement). Used by `scheduleWhenIdle` and
   * `EventsConsumer` to wait for VM-truly-idle without polling. Each
   * observer is fired at most once per registration — observers that need
   * to keep watching must re-register after being called.
   */
  vmIdleObservers: Set<() => void>;
}

/**
 * Returns true when neither the host nor the VM has work in flight.
 *
 * "VM-truly-idle" means:
 *   - No active network/hydration calls (`pendingDeliveries === 0`)
 *   - No pending body-continuation reactions to a recent delivery
 *     (`pendingVmWork === 0`)
 *
 * Both `scheduleWhenIdle` and `EventsConsumer`'s deferred unconsumed-event
 * check are only safe to fire under this condition. The functions consume
 * this single source of truth rather than each maintaining its own timer.
 */
export function isVmIdle(ctx: WorkflowOrchestratorContext): boolean {
  return ctx.pendingDeliveries === 0 && ctx.pendingVmWork === 0;
}

/**
 * Notify observers waiting for the VM to go idle. Called from the
 * decrement-side of `trackVmDelivery` after `pendingVmWork--`. No-op when
 * the host isn't actually idle yet (e.g., a new delivery started between
 * the decrement and the call).
 *
 * Observers are removed from the set before being called so handlers that
 * re-register inside their own callback don't fire reentrantly.
 */
export function notifyVmIdleObservers(ctx: WorkflowOrchestratorContext): void {
  if (!isVmIdle(ctx)) return;
  if (ctx.vmIdleObservers.size === 0) return;
  const observers = Array.from(ctx.vmIdleObservers);
  ctx.vmIdleObservers.clear();
  for (const observer of observers) {
    try {
      observer();
    } catch {
      // Observer errors are not the orchestrator's concern. Don't let one
      // misbehaving observer prevent the others from being notified.
    }
  }
}

/**
 * Wrap a delivery body (the async function that hydrates and resolves a
 * VM-visible promise) so both `pendingDeliveries` and `pendingVmWork` are
 * managed correctly, AND the body runs in event-log order behind
 * `ctx.promiseQueue`.
 *
 * Use this for every event handler that calls `resolvers.resolve()` or
 * `resolvers.reject()` on a VM-visible promise (`step_completed`,
 * `step_failed`, `hook_received`, `hook_conflict`, `wait_completed`, ...).
 * Each of those deliveries opens the same race: between `resolve()` and
 * the body's next `subscribe()`, host-side counters can briefly look
 * idle even though the VM is mid-reaction. Tracking every delivery site
 * uniformly is what makes `isVmIdle(ctx)` a reliable signal.
 *
 * Increment / decrement timing:
 *  - Both counters are bumped synchronously when this function is called,
 *    so a sequence of deliveries observed in the same consume() pass each
 *    add up before any decrement runs.
 *  - `pendingDeliveries` drops synchronously when `body` settles.
 *  - `pendingVmWork` drops one `setImmediate` later, after the current
 *    microtask queue has fully drained.
 *
 * Why `setImmediate` (not `queueMicrotask`): several VM-side patterns
 * chain through multiple microtask hops between `resolve()` and the
 * body's reactive code calling `subscribe()` — most notably the hook
 * async iterator pattern
 *
 *     for await (const payload of hook) { ... }
 *
 * which involves the generator's `yield await this`, the hook's thenable
 * `.then`, and the for-await runtime machinery, each adding a microtask
 * hop. A `queueMicrotask` decrement would land too early, prematurely
 * marking the VM idle while the body is still mid-chain. `setImmediate`
 * fires in the event loop's check phase, which runs only after the
 * current microtask queue has fully drained.
 */
export function trackVmDelivery<T>(
  ctx: WorkflowOrchestratorContext,
  body: () => Promise<T>
): Promise<T> {
  ctx.pendingDeliveries++;
  ctx.pendingVmWork++;
  const decrementVmWork = () => {
    ctx.pendingVmWork--;
    notifyVmIdleObservers(ctx);
  };
  const tracked = ctx.promiseQueue.then(async () => {
    try {
      return await body();
    } finally {
      ctx.pendingDeliveries--;
      setImmediate(decrementVmWork);
    }
  });
  // Continue the queue but swallow rejections so one delivery's failure
  // doesn't poison subsequent deliveries — each body owns its own
  // try/catch.
  ctx.promiseQueue = tracked.then(
    () => {},
    () => {}
  );
  return tracked;
}

/**
 * Schedule a callback to fire only when the VM is genuinely idle — both
 * `pendingDeliveries` and `pendingVmWork` have reached 0 and stayed there
 * across a yield to the event loop.
 *
 * Algorithm:
 *   1. Drain `promiseQueue`, yield one macrotask (`setTimeout(0)`), drain
 *      `promiseQueue` again. This ensures any in-flight microtask chain
 *      that originated before this call has had its first turn to register
 *      next-wave subscribers.
 *   2. Check `isVmIdle(ctx)`. If true, fire `fn()`.
 *   3. If false, register an observer on `vmIdleObservers`. The observer
 *      re-enters step 1 — re-yielding before firing in case a new delivery
 *      starts during the macrotask boundary.
 *   4. A watchdog (`VM_IDLE_WATCHDOG_MS`) force-fires `fn()` if the counter
 *      never reaches idle. This is purely a safety net; the deterministic
 *      counter should drive normal behaviour.
 *
 * Replaces the previous wall-clock heuristic. The counter measures actual
 * VM-side work rather than guessing at a propagation delay.
 *
 * Unlike `EventsConsumer`'s deferred unconsumed-event check, the suspension
 * is NOT cancelled if a new subscribe() registers between the idle
 * notification and the suspension firing — by the time we observe idle, all
 * subscribers that the body was going to register from prior deliveries
 * have registered. A late new delivery would re-increment the counter and
 * delay firing further. If a delivery and re-subscribe happen between the
 * watchdog timeout and the firing, the resulting suspension is harmless
 * (the matching invocation already has `hasCreatedEvent=true`).
 */
export function scheduleWhenIdle(
  ctx: WorkflowOrchestratorContext,
  fn: () => void
): void {
  let fired = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    if (fired) return;
    fired = true;
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    ctx.vmIdleObservers.delete(observer);
    fn();
  };

  const observer = () => {
    // Notified that counters hit 0. Re-yield once before firing in case a
    // new delivery starts during the macrotask boundary (concurrent
    // workflow code can still queue more work).
    drainAndCheck();
  };

  const drainAndCheck = () => {
    if (fired) return;
    ctx.promiseQueue
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(() => ctx.promiseQueue)
      .then(() => {
        if (fired) return;
        if (isVmIdle(ctx)) {
          fire();
          return;
        }
        // Not idle — wait for the next counter-decrement notification.
        // observers are single-shot, so re-register.
        ctx.vmIdleObservers.add(observer);
      });
  };

  watchdog = setTimeout(() => {
    watchdog = null;
    if (fired) return;
    // Counter mechanism failed to settle within the watchdog window.
    // Force-fire to prevent the run from hanging. Logged-not-thrown — the
    // suspension is harmless if a stale delivery materializes after.
    fire();
  }, VM_IDLE_WATCHDOG_MS);

  drainAndCheck();
}
