import type { Event, EventType } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { findDuplicateEventIds } from './duplicate-events';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

let nextId = 0;

function event(
  eventType: EventType,
  options: {
    correlationId?: string;
    /** Seconds after the fixture epoch. Defaults to insertion order. */
    at?: number;
    eventId?: string;
  } = {}
): Event {
  nextId += 1;
  const offsetSeconds = options.at ?? nextId;
  return {
    eventId: options.eventId ?? `evt_${nextId}`,
    runId: 'run_1',
    eventType,
    correlationId: options.correlationId,
    createdAt: new Date(BASE_TIME + offsetSeconds * 1000),
    occurredAt: new Date(BASE_TIME + offsetSeconds * 1000),
    eventData: {},
  } as unknown as Event;
}

describe('findDuplicateEventIds', () => {
  it('returns nothing for a log with no repeats', () => {
    const events = [
      event('run_created'),
      event('run_started'),
      event('step_created', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_completed', { correlationId: 'step_a' }),
      event('run_completed'),
    ];

    expect(findDuplicateEventIds(events)).toEqual(new Set());
  });

  it('flags every repeat after the first of a once-per-entity class', () => {
    const first = event('step_created', { correlationId: 'step_a' });
    const second = event('step_created', { correlationId: 'step_a' });
    const third = event('step_created', { correlationId: 'step_a' });

    expect(findDuplicateEventIds([first, second, third])).toEqual(
      new Set([second.eventId, third.eventId])
    );
  });

  it('treats completed and failed as one terminal class', () => {
    // A concurrent replay writing the other outcome does not move the step off
    // the outcome the run acted on.
    const failed = event('step_failed', { correlationId: 'step_a' });
    const completed = event('step_completed', { correlationId: 'step_a' });

    expect(findDuplicateEventIds([failed, completed])).toEqual(
      new Set([completed.eventId])
    );
  });

  it('keys on the correlation id, so sibling entities never collide', () => {
    const events = [
      event('step_created', { correlationId: 'step_a' }),
      event('step_created', { correlationId: 'step_b' }),
      event('step_completed', { correlationId: 'step_a' }),
      event('step_completed', { correlationId: 'step_b' }),
    ];

    expect(findDuplicateEventIds(events)).toEqual(new Set());
  });

  it('does not flag the repeated events of a retried step', () => {
    // Each attempt legitimately records its own start, and each retryable
    // failure its own step_retrying. Both are consumed, not passed over.
    const events = [
      event('step_created', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_retrying', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_retrying', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_completed', { correlationId: 'step_a' }),
    ];

    expect(findDuplicateEventIds(events)).toEqual(new Set());
  });

  it('does not flag repeated hook deliveries', () => {
    const events = [
      event('hook_created', { correlationId: 'hook_a' }),
      event('hook_received', { correlationId: 'hook_a' }),
      event('hook_received', { correlationId: 'hook_a' }),
      event('hook_disposed', { correlationId: 'hook_a' }),
    ];

    expect(findDuplicateEventIds(events)).toEqual(new Set());
  });

  it('flags run-level repeats, which carry no correlation id', () => {
    const started = event('run_started');
    const startedAgain = event('run_started');
    const completed = event('run_completed');
    const cancelled = event('run_cancelled');

    expect(
      findDuplicateEventIds([started, startedAgain, completed, cancelled])
    ).toEqual(new Set([startedAgain.eventId, cancelled.eventId]));
  });

  it('picks the earliest occurrence whichever way the caller sorted', () => {
    const first = event('wait_created', { at: 1, correlationId: 'wait_a' });
    const second = event('wait_created', { at: 2, correlationId: 'wait_a' });

    const ascending = findDuplicateEventIds([first, second]);
    const descending = findDuplicateEventIds([second, first]);

    expect(ascending).toEqual(new Set([second.eventId]));
    expect(descending).toEqual(ascending);
  });

  it('breaks timestamp ties on the order the log lists them in', () => {
    const first = event('wait_completed', { at: 5, correlationId: 'wait_a' });
    const second = event('wait_completed', { at: 5, correlationId: 'wait_a' });

    expect(findDuplicateEventIds([first, second])).toEqual(
      new Set([second.eventId])
    );
  });
});
