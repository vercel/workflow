import type { QueueItem } from '../global.js';

/**
 * Whether any event an out-of-band writer could append right now is able to
 * change the decisions a suspension leads to. Computed once per suspension
 * that schedules inline steps, and exposed for the run-ahead gate described
 * below. Nothing consumes it for control flow yet; the runtime records it on
 * the invocation span so the eligible share of boundaries can be measured.
 *
 * ## Writers
 *
 * The orchestrator replaying the run is one writer. Every other writer is
 * out-of-band to it:
 *
 * | Writer | Event | Path-changing when |
 * |---|---|---|
 * | webhook / `resumeHook()` | `hook_received` | workflow code is waiting on that hook's next payload |
 * | another run's `createHook({ experimental_force })` | `hook_disposed` | same: it rejects waiting payload awaiters, and later awaits |
 * | a step's `AbortController.abort()` | `hook_received` on a system hook | always: `signal.aborted` and abort listeners are read synchronously, with no `then` to observe |
 * | wait timer | `wait_completed` | the wait is due (see below) |
 * | `run.wakeUp()` / dashboard "cancel sleeps" | `wait_completed` | any time; not detected, see below |
 * | step executors in other invocations | `step_completed` / `step_failed` / `step_retrying` | unknown: step promises are native, so their awaiters are invisible |
 * | `runs.cancel()` | `run_cancelled` | never changes a decision; it ends the run (see "Pipeline depth") |
 * | `setAttributes()` API | `attr_set` | never: workflow code writes attributes but cannot read them |
 *
 * ## Why an unawaited hook is inert
 *
 * On the node:vm engine a `hook_received` for a hook with no waiting consumer
 * is hydrated and buffered as an UNARMED delivery barrier (`workflow/hook.ts`).
 * Step results do not order behind unarmed barriers, the log-order-draws
 * turnstile only waits on armed ones, and the workflow clock advances on
 * delivery rather than consumption (`WorkflowOrchestratorContext.advanceClock`),
 * so the buffered payload moves neither the step results around it nor
 * `Date.now()`. A replay over a log with the payload inserted at any position
 * after the hook's creation, and before its first await, makes the same
 * decisions as one without it. The first `then()` on the hook is visible to the
 * runtime because `Hook` is a custom thenable, which is what
 * `WorkflowSuspension.observedHookIds` records.
 *
 * Over-reporting is possible and safe: a `.then` left behind by a settled
 * `Promise.race` keeps its hook observed although the branch that would read
 * it is gone.
 *
 * The QuickJS engine advances its clock on every event it reads, unclaimed
 * payloads included, so this argument does not hold there. Its suspensions do
 * not carry `observedHookIds`, which classifies every open hook as observed.
 *
 * ## Waits
 *
 * Sleep promises are native, so whether anything still awaits a wait cannot be
 * told. A wait is instead classified by time: one whose `resumeAt` falls within
 * the invocation's inline window plus the clock-skew allowance
 * (`OPEN_WAIT_CLOCK_SKEW_MS`) can have its timer fire while this invocation is
 * still deciding, and counts as path-changing; one due later cannot. The
 * caller computes this from both the log and the suspension's own queue,
 * because either can hold a wait the other lacks.
 *
 * `run.wakeUp()` completes waits regardless of `resumeAt`, so a far-future
 * wait is only inert with respect to its own timer. Today that is a delayed
 * wake at worst. Under run-ahead it is not (see below), so run-ahead has to
 * close that gap before it relies on {@link OutOfBandObservation.inert} with
 * any wait open, for example by treating every open wait as observed while a
 * pipeline is in flight, or by having wake-ups enqueue a delivery instead of
 * writing `wait_completed` directly.
 *
 * ## Intended use: de-opting run-ahead
 *
 * Run-ahead: once an inline step's body returns, feed its result to the
 * retained VM and continue to the next boundary without waiting for the
 * `step_completed` write (and the inline delta it carries) to come back, so
 * consecutive steps overlap their writes. It requires a single-orchestrator
 * guarantee whose stale holders are fenced (their writes refused, not merely
 * their lease taken), which does not exist yet. Without it a second
 * orchestrator is a writer this classification does not cover.
 *
 * Run-ahead removes the property today's replays rest on: a replay's view is a
 * *prefix* of the log, and anything it missed lands after everything it read.
 * A speculative view is the committed prefix plus this invocation's own
 * in-flight writes, and an out-of-band event can commit *between* those writes.
 * A later fresh replay sees it there. If the event was path-changing, that
 * replay decides differently from the writes already committed after it,
 * which is a corrupted log, not a late observation. {@link inert} is the
 * condition under which such an interleaving cannot change any decision.
 *
 * The gate, once run-ahead exists:
 *
 * 1. Evaluate at every boundary, before issuing that boundary's writes.
 *    Observation changes as code runs: the first `await hook` turns a hook
 *    from inert to observed.
 * 2. `inert === false`: do not run ahead past this boundary. Drain the
 *    in-flight writes, fold their skipped-slot reports and deltas into the
 *    log, and let the VM consume them in log order before deciding. That is
 *    today's per-step cost, paid only at these boundaries.
 * 3. `inert === true`: run ahead. Events the in-flight writes report back are
 *    for entities nobody waits on; folding them buffers them, which changes no
 *    decision already taken.
 * 4. A boundary where code is waiting on a hook with nothing else to run needs
 *    no drain to be safe: suspending without a payload only delays the run.
 *    It still drains before parking, so a payload already committed below an
 *    in-flight write is acted on now.
 *
 * ## Pipeline depth
 *
 * Run-ahead must cap how many steps it executes past the last write it has
 * seen confirmed, independently of this classification:
 *
 * - Cancellation. `run_cancelled` never changes a decision, but every step
 *   body started after it committed is a side effect the user asked not to
 *   happen. The depth bounds that to the cap.
 * - Lost invocations. Writes that never land (crash, timeout, lost lease) are
 *   re-executed by whoever recovers the run, so every unconfirmed step is a
 *   possible duplicate side effect.
 * - Drain cost. Rule 2 above waits for every in-flight write; the cap bounds
 *   how long a sync point can stall.
 * - Exposure. The writers this classification cannot see (`run.wakeUp()`,
 *   other step executors, a stale orchestrator) can only interleave inside the
 *   in-flight window, which the cap keeps short.
 *
 * A small fixed depth (one or two unconfirmed steps) captures most of the
 * latency win, since each extra step only saves one more round trip, and
 * should be tunable per deployment like the other inline-loop knobs.
 */
export interface OutOfBandObservation {
  /** Open user hooks with workflow code waiting on their next payload. */
  observedHookCount: number;
  /** Open user hooks nobody is waiting on: their payloads are inert. */
  unobservedHookCount: number;
  /**
   * Open user hooks with unknown observation, because the suspension carried
   * no `observedHookIds`. Counted as path-changing.
   */
  unknownHookCount: number;
  /** Open `AbortController` system hooks: always path-changing. */
  abortSignalHookCount: number;
  /**
   * Pending steps this invocation does not execute itself. Their terminal
   * events come from another executor, and their awaiters cannot be seen, so
   * any of them is counted as path-changing.
   */
  externalStepCount: number;
  /** An open wait can fire before this invocation's inline window ends. */
  waitDue: boolean;
  /**
   * No writer this classification can see is able to append an event that
   * changes the decisions this suspension leads to. Excludes `run.wakeUp()`
   * and a second orchestrator; see the module documentation.
   */
  inert: boolean;
}

export function observeOutOfBandWriters(input: {
  /** The suspension's queue: every open hook, wait, and pending step. */
  items: readonly QueueItem[];
  /** `WorkflowSuspension.observedHookIds`. */
  observedHookIds: ReadonlySet<string> | undefined;
  /** Steps this invocation executes itself (inline or as owner recovery). */
  selfExecutedStepIds: ReadonlySet<string>;
  /** Whether an open wait is due within the invocation's inline window. */
  waitDue: boolean;
}): OutOfBandObservation {
  let observedHookCount = 0;
  let unobservedHookCount = 0;
  let unknownHookCount = 0;
  let abortSignalHookCount = 0;
  let externalStepCount = 0;
  for (const item of input.items) {
    if (item.type === 'step') {
      if (!input.selfExecutedStepIds.has(item.correlationId)) {
        externalStepCount++;
      }
      continue;
    }
    // A hook this suspension disposes is closed by its own write.
    if (item.type !== 'hook' || item.disposed) continue;
    if (item.isSystem) {
      abortSignalHookCount++;
    } else if (input.observedHookIds === undefined) {
      unknownHookCount++;
    } else if (input.observedHookIds.has(item.correlationId)) {
      observedHookCount++;
    } else {
      unobservedHookCount++;
    }
  }
  return {
    observedHookCount,
    unobservedHookCount,
    unknownHookCount,
    abortSignalHookCount,
    externalStepCount,
    waitDue: input.waitDue,
    inert:
      observedHookCount === 0 &&
      unknownHookCount === 0 &&
      abortSignalHookCount === 0 &&
      externalStepCount === 0 &&
      !input.waitDue,
  };
}
