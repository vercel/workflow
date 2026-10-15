import type { Event, EventResult } from '@workflow/world';
import { mergeReportedEvents } from '../helpers.js';

/**
 * How the orchestrator takes in a write of its own that resolves a promise in
 * the workflow (a `wait_completed`, an inline step's `step_completed` or
 * `step_failed`).
 *
 * Such a write can land above an out-of-band event the orchestrator has not
 * seen yet: a background step's outcome, a `hook_received`, a
 * `run_cancelled`. Every later replay consumes that lower event first, and
 * resolution order is observable (correlation ids are minted in call order,
 * and the deterministic clock follows the consumed event). So the VM consumes
 * its own resolving event only after the write committed, and only after the
 * events the write's skipped-slot report names, in position order:
 *
 * - report empty: consume the own event now;
 * - report present and complete: merge it, then the own event;
 * - report incomplete (`reportIncomplete`, or a truncated page): reload the
 *   log before continuing.
 *
 * There is no optimistic fast path that consumes the own event before the
 * commit. The plan describes a structural check that would allow one, and a
 * later refinement that would allow it while hooks, sleeps or background
 * steps are open (single-orchestrator plan, section 4.5, "Later refinement,
 * not needed now"). Neither is built.
 */
export type ConsumeAfterCommit =
  | { type: 'merged'; added: number }
  | { type: 'reload' };

export function consumeOwnResolvingWrite(
  log: Event[],
  result: EventResult
): ConsumeAfterCommit {
  if (result.reportIncomplete === true || result.hasMore === true) {
    return { type: 'reload' };
  }
  const own = result.event;
  if (!own) return { type: 'reload' };
  const reported = (result.events ?? []).filter(
    (event) => event.eventId !== own.eventId
  );
  const added = mergeReportedEvents(log, [...reported, own]);
  return { type: 'merged', added };
}
