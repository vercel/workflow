/**
 * The awaited-resolution fence.
 *
 * Bump-and-report tells a writer what it did not see, but it tells it *after*
 * the write is durable. For most events that is enough: an out-of-band
 * `hook_received` landing ahead of a replay's `wait_created` produces a log
 * that is unusual but replayable, and the consumer parks the delivery until
 * something awaits it. One class is not recoverable that way. When the event
 * the writer missed is the *resolution of something the writer is still
 * waiting on*, the writer's branch decision was made against a world where
 * that promise had not settled — and the branch it took is the one the log now
 * records. No later replay can un-take it.
 *
 * So that one class is fenced: the writer sends the correlation ids it is
 * blocked on, and a World that finds one of their resolutions on a slot the
 * write is about to skip refuses the write instead of committing it. The
 * writer restarts its replay against the corrected log and reaches the branch
 * the resolution decides.
 *
 * Three properties this relies on:
 *
 * - **Refuse before the insert.** A rejection after the fact is useless: the
 *   divergent event is already in the log.
 * - **The whole flush batch fences together.** Every write of one suspension
 *   carries the same `eventCount` and the same awaited set, and the unseen
 *   events sit on the slots directly above that count, so each write in the
 *   batch skips over all of them. Either all of them are fenced or none is;
 *   a partial batch would leave the log poisoned by the siblings that landed.
 * - **Only pre-existing entities are awaited.** An entity this batch is
 *   creating cannot have a resolution the writer missed, so the writer omits
 *   it, and a sibling's inline `step_completed` never fences its own batch.
 */

import type { EventType } from './events.js';

/**
 * Event types that settle something a workflow can be suspended on.
 *
 * `run_cancelled` is here without a correlation id of its own: it resolves
 * every pending promise in the run at once, so a writer that missed it missed
 * the resolution of whatever it is waiting on, whatever that is.
 */
export const RESOLUTION_EVENT_TYPES: ReadonlySet<EventType> =
  new Set<EventType>([
    'step_completed',
    'step_failed',
    'wait_completed',
    'hook_received',
    'run_cancelled',
  ]);

/** The minimum an event needs to expose to be tested against the fence. */
export interface ResolutionCandidate {
  eventType: EventType;
  correlationId?: string | null;
}

/**
 * Whether one event resolves something in `awaiting`.
 *
 * `awaiting` holds correlation ids whose creation event the writer had already
 * loaded — a step it is blocked on, a hook it is reading, a sleep it is inside.
 */
export function resolvesAwaited(
  event: ResolutionCandidate,
  awaiting: ReadonlySet<string>
): boolean {
  if (!RESOLUTION_EVENT_TYPES.has(event.eventType)) {
    return false;
  }
  if (event.eventType === 'run_cancelled') {
    return awaiting.size > 0;
  }
  return event.correlationId ? awaiting.has(event.correlationId) : false;
}

/**
 * The first event in `events` that resolves something in `awaiting`, or
 * `undefined` when none does — in which case the write may proceed.
 */
export function findAwaitedResolution<T extends ResolutionCandidate>(
  events: readonly T[],
  awaiting: Iterable<string>
): T | undefined {
  const set = awaiting instanceof Set ? awaiting : new Set(awaiting);
  if (set.size === 0) {
    return undefined;
  }
  return events.find((event) => resolvesAwaited(event, set));
}

/** Message for the 412 a fenced write is rejected with. */
export function awaitedResolutionMessage(
  blocking: ResolutionCandidate
): string {
  const target = blocking.correlationId ? ` for ${blocking.correlationId}` : '';
  return `Event log moved on: ${blocking.eventType}${target} resolves something this replay is still waiting on`;
}
