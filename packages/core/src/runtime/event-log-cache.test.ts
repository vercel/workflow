import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { EventLogCache } from './event-log-cache.js';

const makeEvent = (eventId: string): Event =>
  ({
    eventId,
    runId: 'wrun_test',
    eventType: 'run_started',
    createdAt: new Date(),
  }) as Event;

describe('EventLogCache', () => {
  it('does not replace a newer prefix with a shorter concurrent load', () => {
    const cache = new EventLogCache();

    cache.set(
      'wrun_test',
      [makeEvent('evnt_a'), makeEvent('evnt_b')],
      'eid:evnt_b'
    );
    cache.set('wrun_test', [makeEvent('evnt_a')], 'eid:evnt_a');

    const retained = cache.get('wrun_test');
    expect(retained?.events.map((event) => event.eventId)).toEqual([
      'evnt_a',
      'evnt_b',
    ]);
    expect(retained?.cursor).toBe('eid:evnt_b');
  });
});
