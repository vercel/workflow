import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { buildDurationMap } from '../src/components/event-list-view.js';

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
  createdAt: string
): Event {
  // Only the fields buildDurationMap reads are required; the rest of Event
  // is opaque to it.
  return {
    eventType,
    correlationId,
    createdAt,
  } as unknown as Event;
}

describe('buildDurationMap → queued duration', () => {
  it('uses the first step_started, not the last, for steps with retries', () => {
    const events: Event[] = [
      ev('step_created', 'step-1', '2026-01-01T00:00:00.000Z'),
      ev('step_started', 'step-1', '2026-01-01T00:00:01.000Z'),
      ev('step_failed', 'step-1', '2026-01-01T00:00:02.000Z'),
      ev('step_retrying', 'step-1', '2026-01-01T00:00:03.000Z'),
      ev('step_started', 'step-1', '2026-01-01T00:00:10.000Z'),
      ev('step_completed', 'step-1', '2026-01-01T00:00:11.000Z'),
    ];

    const map = buildDurationMap(events);
    // 1s between step_created and the first step_started.
    expect(map.get('step-1')?.queued).toBe(1000);
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

    expect(buildDurationMap(ascending).get('step-1')?.queued).toBe(1000);
    expect(buildDurationMap(descending).get('step-1')?.queued).toBe(1000);
  });

  it('still works for a step with a single start (no retry)', () => {
    const events: Event[] = [
      ev('step_created', 'step-2', '2026-01-01T00:00:00.000Z'),
      ev('step_started', 'step-2', '2026-01-01T00:00:00.500Z'),
      ev('step_completed', 'step-2', '2026-01-01T00:00:02.000Z'),
    ];

    expect(buildDurationMap(events).get('step-2')?.queued).toBe(500);
  });

  it('falls back to the started time when no created event is seen', () => {
    const events: Event[] = [
      ev('step_started', 'step-3', '2026-01-01T00:00:05.000Z'),
      ev('step_completed', 'step-3', '2026-01-01T00:00:06.000Z'),
    ];

    expect(buildDurationMap(events).get('step-3')?.queued).toBe(0);
  });
});
