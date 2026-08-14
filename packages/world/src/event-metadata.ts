import type { EventType } from './events.js';

/** Groups events that are mutually exclusive outcomes for one entity. */
const ENTITY_EVENT_CLASS_BY_TYPE = {
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
  return (
    ENTITY_EVENT_CLASS_BY_TYPE as Record<string, EntityEventClass | undefined>
  )[eventType];
}

/** The opaque payload field carried by each event type. */
export const EVENT_DATA_PAYLOAD_FIELD_BY_EVENT_TYPE = {
  run_created: 'input',
  run_started: 'input',
  run_completed: 'output',
  run_failed: 'error',
  step_created: 'input',
  step_started: 'input',
  step_completed: 'result',
  step_failed: 'error',
  step_retrying: 'error',
  hook_created: 'metadata',
  hook_received: 'payload',
} as const satisfies Partial<Record<EventType, string>>;

export type EventDataPayloadField =
  (typeof EVENT_DATA_PAYLOAD_FIELD_BY_EVENT_TYPE)[keyof typeof EVENT_DATA_PAYLOAD_FIELD_BY_EVENT_TYPE];

/** Payload fields removed when events are loaded without referenced data. */
export const EVENT_DATA_REF_FIELDS = Object.fromEntries(
  Object.entries(EVENT_DATA_PAYLOAD_FIELD_BY_EVENT_TYPE).map(
    ([eventType, field]) => [eventType, [field]]
  )
) as Record<string, readonly EventDataPayloadField[]>;

export function getEventDataRefFields(eventType: string): readonly string[] {
  return EVENT_DATA_REF_FIELDS[eventType] ?? [];
}

export function getEventDataPayloadField(
  eventType: string
): EventDataPayloadField | undefined {
  return (
    EVENT_DATA_PAYLOAD_FIELD_BY_EVENT_TYPE as Partial<
      Record<string, EventDataPayloadField>
    >
  )[eventType];
}
