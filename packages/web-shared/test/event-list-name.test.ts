import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { buildNameMaps } from '../src/components/event-list-view.js';

describe('buildNameMaps', () => {
  it('shortens workflow-prefixed step names', () => {
    const event = {
      eventType: 'step_created',
      correlationId: 'step_fetch',
      eventData: {
        stepName: 'workflow//src/billing.ts//fetchInvoices',
      },
    } as unknown as Event;

    const { correlationNameMap } = buildNameMaps([event], null);

    expect(correlationNameMap.get('step_fetch')).toBe('fetchInvoices');
  });
});
