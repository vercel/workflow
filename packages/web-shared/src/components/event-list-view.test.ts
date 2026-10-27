import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { buildNameMaps } from './event-list-view';

function event(
  eventType: Event['eventType'],
  correlationId: string,
  eventData: Record<string, unknown>
): Event {
  return {
    eventId: `evt_${eventType}_${correlationId}`,
    runId: 'run_1',
    eventType,
    correlationId,
    createdAt: new Date(0),
    eventData,
  } as unknown as Event;
}

describe('buildNameMaps', () => {
  it('names a step whose creation is recorded on its step_started', () => {
    const { correlationNameMap } = buildNameMaps(
      [
        event('step_started', 'step_a', {
          stepName: 'step//src/billing.ts//fetchInvoices',
        }),
      ],
      null
    );

    expect(correlationNameMap.get('step_a')).toBe('fetchInvoices');
  });

  it('prefers the step_created name in either list order', () => {
    const created = event('step_created', 'step_a', {
      stepName: 'step//src/billing.ts//fetchInvoices',
      input: null,
    });
    const started = event('step_started', 'step_a', {
      stepName: 'step//src/billing.ts//somethingElse',
    });

    for (const events of [
      [created, started],
      [started, created],
    ]) {
      const { correlationNameMap } = buildNameMaps(events, null);
      expect(correlationNameMap.get('step_a')).toBe('fetchInvoices');
    }
  });
});
