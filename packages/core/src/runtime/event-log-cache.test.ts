import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLogCache } from './event-log-cache.js';

const makeEvent = (eventId: string): Event =>
  ({
    eventId,
    runId: 'wrun_test',
    eventType: 'run_started',
    createdAt: new Date(),
  }) as Event;

describe('EventLogCache', () => {
  const originalEnv = {
    disabled: process.env.WORKFLOW_DISABLE_EVENT_CACHE,
    maxBytes: process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES,
    maxEntries: process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES,
  };

  beforeEach(() => {
    delete process.env.WORKFLOW_DISABLE_EVENT_CACHE;
    delete process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES;
    delete process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES;
  });

  afterEach(() => {
    if (originalEnv.disabled === undefined) {
      delete process.env.WORKFLOW_DISABLE_EVENT_CACHE;
    } else {
      process.env.WORKFLOW_DISABLE_EVENT_CACHE = originalEnv.disabled;
    }
    if (originalEnv.maxBytes === undefined) {
      delete process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES;
    } else {
      process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES = originalEnv.maxBytes;
    }
    if (originalEnv.maxEntries === undefined) {
      delete process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES;
    } else {
      process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES = originalEnv.maxEntries;
    }
  });

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

  it('does not retain or return prefixes while the cache is disabled', () => {
    process.env.WORKFLOW_DISABLE_EVENT_CACHE = '1';
    const cache = new EventLogCache();

    cache.set('wrun_test', [makeEvent('evnt_a')], 'eid:evnt_a');

    expect(cache.get('wrun_test')).toBeUndefined();
  });

  it('uses the configured entry-count limit', () => {
    process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES = '1';
    const cache = new EventLogCache();

    cache.set('wrun_a', [makeEvent('evnt_a')], 'eid:evnt_a');
    cache.set('wrun_b', [makeEvent('evnt_b')], 'eid:evnt_b');

    expect(cache.get('wrun_a')).toBeUndefined();
    expect(cache.get('wrun_b')?.cursor).toBe('eid:evnt_b');
  });

  it('retains one large prefix when it fits within the total byte limit', () => {
    process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES = String(1024 * 1024);
    const cache = new EventLogCache();
    const largeEvent = {
      ...makeEvent('evnt_large'),
      eventData: { input: new Uint8Array(768 * 1024) },
    } as Event;

    cache.set('wrun_test', [largeEvent], 'eid:evnt_large');

    expect(cache.get('wrun_test')?.cursor).toBe('eid:evnt_large');
  });
});
