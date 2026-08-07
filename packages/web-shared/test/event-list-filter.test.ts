import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { eventMatchesTextFilter } from '../src/components/event-list-view.js';

function ev(
  eventType: string,
  correlationId: string | null,
  eventId: string
): Pick<Event, 'eventType' | 'correlationId' | 'eventId'> {
  return {
    eventType,
    correlationId,
    eventId,
  } as unknown as Pick<Event, 'eventType' | 'correlationId' | 'eventId'>;
}

describe('eventMatchesTextFilter', () => {
  const stepCompleted = ev(
    'step_completed',
    'step_01KB0N33GKQ92T1V4B6P3HKR2X',
    'evnt_01KZCVPHQ01BYYKXK0GXKR824F'
  );

  it('matches everything for an empty or whitespace query', () => {
    expect(eventMatchesTextFilter(stepCompleted, '', 'chargePayment')).toBe(
      true
    );
    expect(eventMatchesTextFilter(stepCompleted, '   ', 'chargePayment')).toBe(
      true
    );
  });

  it('matches the raw event type', () => {
    expect(eventMatchesTextFilter(stepCompleted, 'step_comp', null)).toBe(true);
    expect(eventMatchesTextFilter(stepCompleted, 'hook', null)).toBe(false);
  });

  it('matches the formatted event type, case-insensitively', () => {
    expect(eventMatchesTextFilter(stepCompleted, 'Step completed', null)).toBe(
      true
    );
    expect(eventMatchesTextFilter(stepCompleted, 'COMPLETED', null)).toBe(true);
  });

  it('matches the resolved entity name', () => {
    expect(
      eventMatchesTextFilter(stepCompleted, 'chargepay', 'chargePayment')
    ).toBe(true);
    expect(
      eventMatchesTextFilter(stepCompleted, 'sendConfirmation', 'chargePayment')
    ).toBe(false);
  });

  it('matches correlation and event ID substrings', () => {
    expect(eventMatchesTextFilter(stepCompleted, 'step_01kb0n33', null)).toBe(
      true
    );
    expect(eventMatchesTextFilter(stepCompleted, 'KR824F', null)).toBe(true);
  });

  it('handles events without a correlation ID', () => {
    const runCreated = ev('run_created', null, 'evnt_run');
    expect(eventMatchesTextFilter(runCreated, 'run cre', null)).toBe(true);
    expect(eventMatchesTextFilter(runCreated, 'step', null)).toBe(false);
  });
});
