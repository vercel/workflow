import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { buildEventTiming } from '../src/lib/event-list-model.js';

/**
 * Regression tests for the "Queued for" duration shown in the Events tab.
 *
 * A retried step emits multiple `step_started` events for the same
 * correlationId. The queued duration must be anchored on the FIRST
 * `step_started` (time from `step_created` to first attempt), not the last,
 * so the displayed value reflects how long the step waited before any work
 * began.
 */

function ev(
  eventType: string,
  correlationId: string | null,
  createdAt: string,
  occurredAt?: string
): Event {
  // Only the fields buildEventTiming reads are required; the rest of Event
  // is opaque to it.
  return {
    eventId: `evnt_${eventType}_${createdAt}`,
    eventType,
    correlationId,
    createdAt,
    occurredAt,
  } as unknown as Event;
}

/** The queued segment of a step's breakdown: created to its first start. */
function queuedMs(events: Event[], stepId: string): number | undefined {
  return buildEventTiming(events)
    .stepSegments.get(stepId)
    ?.find((segment) => segment.kind === 'queued')?.ms;
}

describe('buildEventTiming → queued duration', () => {
  it('uses the first step_started, not the last, for steps with retries', () => {
    const events: Event[] = [
      ev('step_created', 'step-1', '2026-01-01T00:00:00.000Z'),
      ev('step_started', 'step-1', '2026-01-01T00:00:01.000Z'),
      ev('step_failed', 'step-1', '2026-01-01T00:00:02.000Z'),
      ev('step_retrying', 'step-1', '2026-01-01T00:00:03.000Z'),
      ev('step_started', 'step-1', '2026-01-01T00:00:10.000Z'),
      ev('step_completed', 'step-1', '2026-01-01T00:00:11.000Z'),
    ];

    // 1s between step_created and the first step_started.
    expect(queuedMs(events, 'step-1')).toBe(1000);
  });

  it('handles events in descending order (newest first)', () => {
    const ascending: Event[] = [
      ev('step_created', 'step-1', '2026-01-01T00:00:00.000Z'),
      ev('step_started', 'step-1', '2026-01-01T00:00:01.000Z'),
      ev('step_failed', 'step-1', '2026-01-01T00:00:02.000Z'),
      ev('step_started', 'step-1', '2026-01-01T00:00:10.000Z'),
      ev('step_completed', 'step-1', '2026-01-01T00:00:11.000Z'),
    ];
    const descending = [...ascending].reverse();

    expect(queuedMs(ascending, 'step-1')).toBe(1000);
    expect(queuedMs(descending, 'step-1')).toBe(1000);
  });

  it('still works for a step with a single start (no retry)', () => {
    const events: Event[] = [
      ev('step_created', 'step-2', '2026-01-01T00:00:00.000Z'),
      ev('step_started', 'step-2', '2026-01-01T00:00:00.500Z'),
      ev('step_completed', 'step-2', '2026-01-01T00:00:02.000Z'),
    ];

    expect(queuedMs(events, 'step-2')).toBe(500);
  });

  it('prefers occurredAt over createdAt when measuring durations', () => {
    const completed = ev(
      'step_completed',
      'step-occurred',
      '2026-01-01T00:00:12.000Z',
      '2026-01-01T00:00:01.000Z'
    );
    const events: Event[] = [
      ev(
        'step_created',
        'step-occurred',
        '2026-01-01T00:00:10.000Z',
        '2026-01-01T00:00:00.000Z'
      ),
      ev(
        'step_started',
        'step-occurred',
        '2026-01-01T00:00:11.000Z',
        '2026-01-01T00:00:00.250Z'
      ),
      completed,
    ];

    expect(queuedMs(events, 'step-occurred')).toBe(250);
    expect(buildEventTiming(events).eventDurations.get(completed.eventId)).toBe(
      750
    );
  });

  it('has no queued time when no created event is seen', () => {
    const events: Event[] = [
      ev('step_started', 'step-3', '2026-01-01T00:00:05.000Z'),
      ev('step_completed', 'step-3', '2026-01-01T00:00:06.000Z'),
    ];

    expect(queuedMs(events, 'step-3')).toBeUndefined();
  });
});

describe('buildEventTiming → retried step', () => {
  it('measures each attempt from its own start and splits the step into segments', () => {
    const retrying = ev('step_retrying', 'step-1', '2026-01-01T00:00:03.000Z');
    const completed = ev(
      'step_completed',
      'step-1',
      '2026-01-01T00:00:08.500Z'
    );
    const { eventDurations, stepSegments } = buildEventTiming([
      ev('step_created', 'step-1', '2026-01-01T00:00:00.000Z'),
      ev('step_started', 'step-1', '2026-01-01T00:00:01.000Z'),
      retrying,
      ev('step_started', 'step-1', '2026-01-01T00:00:08.000Z'),
      completed,
    ]);

    expect(eventDurations.get(retrying.eventId)).toBe(2000);
    expect(eventDurations.get(completed.eventId)).toBe(500);
    expect(stepSegments.get('step-1')).toEqual([
      { kind: 'queued', label: 'Queued', ms: 1000 },
      { kind: 'failed', label: 'Attempt 1 · failed', ms: 2000 },
      { kind: 'backoff', label: 'Backoff', ms: 5000 },
      { kind: 'ok', label: 'Attempt 2 · ok', ms: 500 },
    ]);
  });
});

describe('buildEventTiming → waits and the run', () => {
  it('measures each from the event that opened it', () => {
    const waitCompleted = ev(
      'wait_completed',
      'wait-1',
      '2026-01-01T00:00:04.000Z'
    );
    const runCompleted = ev('run_completed', null, '2026-01-01T00:00:05.000Z');
    const { eventDurations } = buildEventTiming([
      ev('run_created', null, '2026-01-01T00:00:00.000Z'),
      ev('run_started', null, '2026-01-01T00:00:01.000Z'),
      ev('wait_created', 'wait-1', '2026-01-01T00:00:02.000Z'),
      waitCompleted,
      runCompleted,
    ]);

    expect(eventDurations.get(waitCompleted.eventId)).toBe(2000);
    expect(eventDurations.get(runCompleted.eventId)).toBe(4000);
  });
});
