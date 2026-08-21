import { type Event, isSealedNoopEvent as isSealedNoop } from '@workflow/world';

/**
 * Sealed-position `noop` events (specVersion 7).
 *
 * A sealed-log backend hands each write its position before the write
 * commits, so a writer that dies after claiming a position leaves a hole.
 * The backend closes a provably abandoned hole by writing a `noop` event
 * into it — a log-only row the run itself never observes: replay steps over
 * it without offering it to any consumer and without advancing the
 * deterministic clock.
 *
 * The observability UI mirrors that treatment. A `noop` appears in event
 * lists (greyed, with {@link SEALED_EVENT_MESSAGE} on hover) because it is a
 * real row of the log, but it is excluded from span geometry and from
 * trace-duration bounds: its `createdAt` is the *sealer's* wall clock, which
 * can postdate every real event around it, and letting it stretch a span or
 * the trace's known duration would chart the sealer's schedule rather than
 * the run's.
 */
export const SEALED_EVENT_MESSAGE =
  'No-op events are written by the backend to seal an abandoned log position';

/**
 * Whether `event` is a backend-written seal for an abandoned position.
 *
 * Delegates to `@workflow/world` so the UI, the `node:vm` engine and the
 * QuickJS engine cannot drift on what a seal is.
 */
export function isSealedNoopEvent(event: Pick<Event, 'eventType'>): boolean {
  return isSealedNoop(event);
}
