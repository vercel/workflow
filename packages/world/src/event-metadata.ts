import type { EventType } from './events.js';

function getOwnProperty<T extends object>(
  object: T,
  key: string
): T[keyof T] | undefined {
  return Object.hasOwn(object, key) ? object[key as keyof T] : undefined;
}

/**
 * Whether an event is a sealed-log filler occupying an abandoned slot.
 *
 * The single home for this test, deliberately: a noop is invisible to the run
 * but it is a real row of the log, so every pass over a log has to decide
 * whether it is walking positions (count it) or reconstructing what happened
 * (skip it). The replay engines and observability trace builder must agree
 * that a noop's `createdAt` — the sealer's wall clock, which can postdate every
 * real event around it — never becomes a time the run observed.
 *
 * Keeping the classifier in this schema-free module lets replay code make that
 * decision without pulling the event validation graph into workflow bundles.
 */
export function isSealedNoopEvent(event: { eventType: string }): boolean {
  return event.eventType === 'noop';
}

/**
 * Groups event types into the classes a replay tracks per entity: the entity
 * named by the event's `correlationId`, or the run itself for run events,
 * which carry none.
 *
 * Types that share a class are the mutually exclusive outcomes of one
 * decision, so the log records the class once and the first event of it is the
 * one that counts: a step either completes or fails.
 *
 * Classes are independent of each other. A step whose result is in the log has
 * still recorded exactly one `step_created`, and can still record another
 * `step_started` if an attempt is running somewhere. What a class bounds is
 * which events can be *ignored*: a replay may pass over an event whose class
 * it already recorded for that entity and which no consumer wants (see
 * `EventsConsumer`), and only then.
 *
 * `attr_set` is here for the correlation id a workflow-body attribute write
 * draws, which resolves exactly once: the dispatcher's consumer takes the
 * matching event and deregisters, so a second event under that id has no
 * callback left and never will. Without a class it would instead be parked for
 * a consumer that cannot come, and parking is only ever settled by the
 * workflow function returning, at which point it is reported as a stranded
 * event and kills a run that did all its work correctly. An attribute write
 * from a *step* body carries no correlation id and is claimed by the
 * structural lifecycle consumer in `workflow.ts` on the way past, so it is
 * consumed rather than skipped and several of them never collapse into one
 * class.
 *
 * Note the omissions, all of them types a mapping would be dead weight for.
 * `hook_received` and `hook_conflict` are deliveries whose consumer subscribes
 * lazily, and `run_created` precedes every replay. The terminal run types are
 * absent for a different reason: recording a class requires a consumer to take
 * an event of it, and no consumer takes `run_completed` / `run_failed` /
 * `run_cancelled`: the runtime exits before replaying the body once the log
 * holds one, so they never reach a consumer at all. An entry for them could
 * never match.
 */
const ENTITY_EVENT_CLASS_BY_TYPE = {
  attr_set: 'attr_set',
  step_created: 'step_created',
  step_started: 'step_started',
  step_retrying: 'step_retrying',
  step_completed: 'step_terminal',
  step_failed: 'step_terminal',
  wait_created: 'wait_created',
  wait_completed: 'wait_completed',
  hook_created: 'hook_created',
  hook_disposed: 'hook_disposed',
  run_started: 'run_started',
} as const satisfies Partial<Record<EventType, string>>;

export type EntityEventClass =
  (typeof ENTITY_EVENT_CLASS_BY_TYPE)[keyof typeof ENTITY_EVENT_CLASS_BY_TYPE];

export function entityEventClass(
  eventType: string
): EntityEventClass | undefined {
  return getOwnProperty(ENTITY_EVENT_CLASS_BY_TYPE, eventType);
}

/** Opaque payload fields removed when events load without referenced data. */
const EVENT_DATA_REF_FIELDS_BY_EVENT_TYPE = {
  run_created: ['input'],
  run_started: ['input'],
  run_completed: ['output'],
  run_failed: ['error'],
  step_created: ['input'],
  step_started: ['input'],
  step_completed: ['result'],
  step_failed: ['error'],
  step_retrying: ['error'],
  hook_created: ['metadata'],
  hook_received: ['payload'],
} as const satisfies Partial<Record<EventType, readonly [string]>>;

export type EventDataPayloadField =
  (typeof EVENT_DATA_REF_FIELDS_BY_EVENT_TYPE)[keyof typeof EVENT_DATA_REF_FIELDS_BY_EVENT_TYPE][number];

const NO_EVENT_DATA_REF_FIELDS: readonly EventDataPayloadField[] = [];

export function getEventDataRefFields(
  eventType: string
): readonly EventDataPayloadField[] {
  return (
    getOwnProperty(EVENT_DATA_REF_FIELDS_BY_EVENT_TYPE, eventType) ??
    NO_EVENT_DATA_REF_FIELDS
  );
}

export function getEventDataPayloadField(
  eventType: string
): EventDataPayloadField | undefined {
  return getEventDataRefFields(eventType)[0];
}
