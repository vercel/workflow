import type { EventType } from './events.js';

function getOwnProperty<T extends object>(
  object: T,
  key: string
): T[keyof T] | undefined {
  return Object.hasOwn(object, key) ? object[key as keyof T] : undefined;
}

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
