import type { Event } from '@workflow/world';

/**
 * Run-lifecycle events. The orchestrator's structural subscriber consumes
 * these; no workflow-body call does.
 */
const STRUCTURAL_EVENT_TYPES = new Set<Event['eventType']>([
  'run_created',
  'run_started',
]);

/**
 * Whether an event may move the VM's replay clock (`Date.now()`, `new Date()`).
 *
 * Only events a workflow-body call consumes qualify, because only those are
 * consumed at a point the body's own progress determines. Run-lifecycle events
 * are not: under turbo the first delivery backgrounds `run_started` and skips
 * the initial event preload, so pass 1 sees neither event, while every later
 * replay has both waiting in the log. Whether the consumer's queued drain
 * reaches them before the body's first statement then depends on whether
 * hydrating the run input yields to the event loop — it does whenever the
 * input is encrypted, compressed, or offloaded. So a `Date.now()` read before
 * the first suspension could return the seed on one pass and
 * `run_started.createdAt` on another: the exact non-determinism the pinned
 * clock exists to prevent, and intermittent in a way that reads as flake.
 * Worse, the two values then get mixed — a `sleep()` deadline computed on pass
 * 1 is compared against a start time re-read on the final replay.
 *
 * Nothing is lost by ignoring them. The clock is already seeded from the run's
 * creation time (recovered from the ULID in `runId`), and `run_started`'s own
 * time reaches workflow code as `workflowStartedAt` on the workflow context.
 *
 * Step-written `attr_set` is also structurally consumed but is deliberately
 * left advancing the clock: it appears in the log at a fixed position relative
 * to the step events around it, so unlike the run-lifecycle pair its
 * consumption point is stable across passes.
 */
export function advancesReplayClock(event: Event): boolean {
  return !STRUCTURAL_EVENT_TYPES.has(event.eventType);
}
