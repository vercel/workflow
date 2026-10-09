import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { getCancellationReason } from './cancellation-reason';

const event = (eventType: Event['eventType'], cancelReason?: string): Event =>
  ({
    eventId: `evnt_${eventType}`,
    runId: 'wrun_cancellation_reason_test',
    eventType,
    createdAt: new Date('2026-09-18T00:00:00.000Z'),
    specVersion: 2,
    ...(eventType === 'run_cancelled'
      ? { eventData: { cancelReason } }
      : undefined),
  }) as Event;

describe('getCancellationReason', () => {
  it('returns the most recent non-empty cancellation reason', () => {
    expect(
      getCancellationReason([
        event('run_cancelled', 'superseded'),
        event('run_started'),
        event('run_cancelled', '  stopped by operator  '),
      ])
    ).toBe('stopped by operator');
  });

  it('returns undefined when cancellation has no reason', () => {
    expect(getCancellationReason([event('run_cancelled', '   ')])).toBe(
      undefined
    );
    expect(getCancellationReason(null)).toBe(undefined);
  });
});
