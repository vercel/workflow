import type { Event, EventType } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { materializeSteps } from './event-materialization';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

let nextId = 0;

function event(
  eventType: EventType,
  options: { correlationId?: string; at?: number } = {}
): Event {
  nextId += 1;
  const offsetSeconds = options.at ?? nextId;
  return {
    eventId: `evt_${nextId}`,
    runId: 'run_1',
    eventType,
    correlationId: options.correlationId,
    createdAt: new Date(BASE_TIME + offsetSeconds * 1000),
    occurredAt: new Date(BASE_TIME + offsetSeconds * 1000),
    eventData: eventType === 'step_created' ? { stepName: 'doWork' } : {},
  } as unknown as Event;
}

describe('materializeSteps', () => {
  it('derives status and timings from the run of a well-formed step', () => {
    const events = [
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', { correlationId: 'step_a', at: 2 }),
      event('step_completed', { correlationId: 'step_a', at: 5 }),
    ];

    const [step] = materializeSteps(events);

    expect(step.status).toBe('completed');
    expect(step.attempt).toBe(1);
    expect(step.startedAt?.getTime()).toBe(BASE_TIME + 2000);
    expect(step.completedAt?.getTime()).toBe(BASE_TIME + 5000);
  });

  it('counts one attempt per start across retries', () => {
    const events = [
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', { correlationId: 'step_a', at: 2 }),
      event('step_retrying', { correlationId: 'step_a', at: 3 }),
      event('step_started', { correlationId: 'step_a', at: 4 }),
      event('step_completed', { correlationId: 'step_a', at: 6 }),
    ];

    const [step] = materializeSteps(events);

    expect(step.attempt).toBe(2);
    expect(step.status).toBe('completed');
    // The first start is when the step went from queued to running.
    expect(step.startedAt?.getTime()).toBe(BASE_TIME + 2000);
  });

  it('keeps the outcome the run acted on when a replay writes another one', () => {
    const events = [
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', { correlationId: 'step_a', at: 2 }),
      event('step_failed', { correlationId: 'step_a', at: 3 }),
      // Written by a concurrent replay working from a stale prefix.
      event('step_completed', { correlationId: 'step_a', at: 9 }),
    ];

    const [step] = materializeSteps(events, { isCompleteHistory: true });

    expect(step.status).toBe('failed');
    expect(step.completedAt?.getTime()).toBe(BASE_TIME + 3000);
    expect(step.updatedAt.getTime()).toBe(BASE_TIME + 3000);
  });

  it('still lists the passed-over event on the entity', () => {
    const events = [
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', { correlationId: 'step_a', at: 2 }),
      event('step_failed', { correlationId: 'step_a', at: 3 }),
      event('step_completed', { correlationId: 'step_a', at: 9 }),
    ];

    const [step] = materializeSteps(events, { isCompleteHistory: true });

    expect(step.events).toHaveLength(4);
  });

  it('takes the last outcome when the log may be incomplete', () => {
    const events = [
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', { correlationId: 'step_a', at: 2 }),
      event('step_failed', { correlationId: 'step_a', at: 3 }),
      event('step_completed', { correlationId: 'step_a', at: 9 }),
    ];

    // On a page of the log there is no telling which failure the run acted on,
    // so nothing is passed over and the fold reports what it was given.
    const [step] = materializeSteps(events);

    expect(step.status).toBe('completed');
  });

  it('counts a repeated creation as one attempt while the step is open', () => {
    const events = [
      event('step_created', { correlationId: 'step_a', at: 1 }),
      // A live step consumer claims this, so it is an attempt, not a repeat.
      event('step_created', { correlationId: 'step_a', at: 2 }),
      event('step_started', { correlationId: 'step_a', at: 3 }),
    ];

    const [step] = materializeSteps(events, { isCompleteHistory: true });

    expect(step.events).toHaveLength(3);
    expect(step.status).toBe('running');
    expect(step.attempt).toBe(1);
  });
});
