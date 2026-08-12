import type { EventType } from '../events.js';

/**
 * Logs that mix events a replay reads past with events that only look like it.
 *
 * Two codebases answer the same question about a log and must answer it the
 * same way. The runtime decides it while replaying: `EventsConsumer` passes
 * over an event whose class it already consumed for that entity and which
 * every registered callback declined. The observability UI decides it after
 * the fact, from the log alone, with no consumers to ask. It stands in for
 * them with the log's own record of when each entity finished, because that is
 * the point past which the runtime has no consumer left for the entity.
 *
 * The two rules agree on every fixture here, and the interesting ones are the
 * near misses: a retried step writes several `step_started` events that are
 * all consumed, and a step that is still open absorbs a second `step_created`.
 * Reading those as repeats would grey out attempts that ran.
 *
 * Each fixture is a whole run's log in log order, which is what both rules
 * take as input. Entities are named, not correlation-id shaped, so each side
 * can mint ids in whatever form it drives.
 */
export interface DuplicateEventFixtureEvent {
  eventType: EventType;
  /** The entity the event belongs to. Run-level events belong to none. */
  entity?: string;
}

export interface DuplicateEventFixture {
  name: string;
  /** What makes this log worth pinning down. */
  why: string;
  /** One run's whole log, in log order. */
  events: DuplicateEventFixtureEvent[];
  /**
   * Indices into {@link events} of the events no consumer claims: the ones the
   * runtime steps over and the UI greys out. Every other index is an event the
   * run acted on.
   */
  ignoredIndices: number[];
}

export const DUPLICATE_EVENT_FIXTURES: readonly DuplicateEventFixture[] = [
  {
    name: 'start after the step completed',
    why: 'A replay working from a prefix that predates the result re-invokes a step whose outcome is already recorded.',
    events: [
      { eventType: 'run_created' },
      { eventType: 'run_started' },
      { eventType: 'step_created', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
      { eventType: 'step_completed', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
    ],
    ignoredIndices: [5],
  },
  {
    name: 'retry attempts',
    why: 'Each attempt of a retried step writes its own start, and the live step consumer claims every one of them.',
    events: [
      { eventType: 'step_created', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
      { eventType: 'step_retrying', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
      { eventType: 'step_retrying', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
      { eventType: 'step_completed', entity: 'step_a' },
    ],
    ignoredIndices: [],
  },
  {
    name: 'second creation of an open step',
    why: 'A step that has not finished still has a consumer, and it absorbs the repeat rather than leaving it unclaimed.',
    events: [
      { eventType: 'step_created', entity: 'step_a' },
      { eventType: 'step_created', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
    ],
    ignoredIndices: [],
  },
  {
    name: 'second outcome for one step',
    why: 'Completion and failure are one class, so the later outcome is a repeat of the earlier one whichever way round they land.',
    events: [
      { eventType: 'step_created', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
      { eventType: 'step_failed', entity: 'step_a' },
      { eventType: 'step_completed', entity: 'step_a' },
    ],
    ignoredIndices: [3],
  },
  {
    name: 'class the log has not recorded yet',
    why: 'The trailing start repeats nothing, so nobody claiming it is divergence rather than a repeat, and neither side may hide it.',
    events: [
      { eventType: 'step_created', entity: 'step_a' },
      { eventType: 'step_completed', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
    ],
    ignoredIndices: [],
  },
  {
    name: 'sleep recreated after it elapsed',
    why: 'Waits close on completion the way steps close on their outcome.',
    events: [
      { eventType: 'wait_created', entity: 'wait_a' },
      { eventType: 'wait_completed', entity: 'wait_a' },
      { eventType: 'wait_created', entity: 'wait_a' },
    ],
    ignoredIndices: [2],
  },
  {
    name: 'repeated hook deliveries',
    why: 'Deliveries belong to no class: a hook can be called any number of times, and every call is a call the run saw.',
    events: [
      { eventType: 'hook_created', entity: 'hook_a' },
      { eventType: 'hook_received', entity: 'hook_a' },
      { eventType: 'hook_received', entity: 'hook_a' },
      { eventType: 'hook_disposed', entity: 'hook_a' },
    ],
    ignoredIndices: [],
  },
  {
    name: 'two steps in flight',
    why: 'Classes are tracked per entity, so sibling steps running the same shape never collide.',
    events: [
      { eventType: 'step_created', entity: 'step_a' },
      { eventType: 'step_created', entity: 'step_b' },
      { eventType: 'step_started', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_b' },
      { eventType: 'step_completed', entity: 'step_b' },
      { eventType: 'step_completed', entity: 'step_a' },
    ],
    ignoredIndices: [],
  },
  {
    name: 'second start of the run',
    why: 'Run events carry no correlation id and share one bucket. Two replays can each write a start, and the run has one.',
    events: [
      { eventType: 'run_created' },
      { eventType: 'run_started' },
      { eventType: 'run_started' },
      { eventType: 'step_created', entity: 'step_a' },
      { eventType: 'step_started', entity: 'step_a' },
    ],
    ignoredIndices: [2],
  },
];
