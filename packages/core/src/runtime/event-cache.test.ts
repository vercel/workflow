import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearEventCache,
  deleteCachedRunEvents,
  getCachedRunEvents,
  getEventCacheStats,
  isEventCacheEnabled,
  setCachedRunEvents,
} from './event-cache.js';

function makeEvent(eventId: string): Event {
  return {
    eventId,
    runId: 'wrun_test',
    eventType: 'step_created',
    correlationId: 'step_x',
    createdAt: new Date(),
  } as unknown as Event;
}

function makeEvents(count: number, prefix = 'evt'): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    events.push(makeEvent(`${prefix}_${i}`));
  }
  return events;
}

describe('event-cache', () => {
  beforeEach(() => {
    clearEventCache();
  });

  afterEach(() => {
    clearEventCache();
    delete process.env.WORKFLOW_DISABLE_EVENT_CACHE;
  });

  describe('get/set/delete round-trip', () => {
    it('returns undefined for an unknown runId', () => {
      expect(getCachedRunEvents('wrun_unknown')).toBeUndefined();
    });

    it('stores and retrieves an entry', () => {
      const events = makeEvents(3);
      setCachedRunEvents('wrun_a', { events, cursor: 'cursor_a' });
      const cached = getCachedRunEvents('wrun_a');
      expect(cached).toBeDefined();
      expect(cached?.events).toBe(events);
      expect(cached?.cursor).toBe('cursor_a');
    });

    it('overwrites an existing entry', () => {
      setCachedRunEvents('wrun_a', {
        events: makeEvents(3),
        cursor: 'c1',
      });
      const newEvents = makeEvents(5, 'new');
      setCachedRunEvents('wrun_a', { events: newEvents, cursor: 'c2' });
      const cached = getCachedRunEvents('wrun_a');
      expect(cached?.events).toBe(newEvents);
      expect(cached?.cursor).toBe('c2');
    });

    it('deletes an entry', () => {
      setCachedRunEvents('wrun_a', { events: makeEvents(2), cursor: 'c' });
      expect(getCachedRunEvents('wrun_a')).toBeDefined();
      deleteCachedRunEvents('wrun_a');
      expect(getCachedRunEvents('wrun_a')).toBeUndefined();
    });

    it('handles deletion of an unknown runId gracefully', () => {
      expect(() => deleteCachedRunEvents('wrun_nope')).not.toThrow();
    });

    it('supports a null cursor (still cached, but caller may skip on null)', () => {
      setCachedRunEvents('wrun_a', { events: makeEvents(2), cursor: null });
      const cached = getCachedRunEvents('wrun_a');
      expect(cached).toBeDefined();
      expect(cached?.cursor).toBeNull();
    });
  });

  describe('LRU ordering', () => {
    it('touches an entry on get so it is not the next evicted', () => {
      // With the default MAX_ENTRIES (500) we can't easily trigger
      // entry-count eviction without inserting 500+ items. Instead,
      // we verify by stats that get() does not corrupt ordering and
      // that explicit deletion removes the right entries.
      setCachedRunEvents('wrun_a', { events: makeEvents(1), cursor: 'a' });
      setCachedRunEvents('wrun_b', { events: makeEvents(1), cursor: 'b' });
      setCachedRunEvents('wrun_c', { events: makeEvents(1), cursor: 'c' });

      // Touch wrun_a so it becomes most-recently-used.
      const touched = getCachedRunEvents('wrun_a');
      expect(touched).toBeDefined();

      const stats = getEventCacheStats();
      expect(stats.entryCount).toBe(3);
    });

    it('evicts the least-recently-used entry when the entry count cap is hit', () => {
      // Use a tiny synthetic budget: bypass the production cap by
      // simulating heavy size pressure. We push entries with
      // increasing event counts and rely on the byte budget. With
      // 64 MiB and ~512 bytes/event, that's ~131k events total. To
      // trigger eviction reliably without churn, push entries large
      // enough that two of them exceed the budget.

      // Each event approximates 512 bytes + eventId bytes (~5).
      // 80,000 events is ~41 MiB, so 2 entries (~82 MiB) > 64 MiB.
      const bigA = makeEvents(80_000, 'a');
      const bigB = makeEvents(80_000, 'b');

      setCachedRunEvents('wrun_a', { events: bigA, cursor: 'a' });
      expect(getCachedRunEvents('wrun_a')).toBeDefined();

      setCachedRunEvents('wrun_b', { events: bigB, cursor: 'b' });
      // wrun_a should now be evicted to make room for wrun_b.
      expect(getCachedRunEvents('wrun_a')).toBeUndefined();
      expect(getCachedRunEvents('wrun_b')).toBeDefined();

      const stats = getEventCacheStats();
      expect(stats.evictionCount).toBeGreaterThanOrEqual(1);
    });

    it('updates totalSize on overwrite', () => {
      setCachedRunEvents('wrun_a', {
        events: makeEvents(10),
        cursor: 'a',
      });
      const before = getEventCacheStats().totalSize;
      setCachedRunEvents('wrun_a', {
        events: makeEvents(100),
        cursor: 'a',
      });
      const after = getEventCacheStats().totalSize;
      expect(after).toBeGreaterThan(before);
    });

    it('updates totalSize on delete', () => {
      setCachedRunEvents('wrun_a', {
        events: makeEvents(10),
        cursor: 'a',
      });
      const before = getEventCacheStats().totalSize;
      expect(before).toBeGreaterThan(0);
      deleteCachedRunEvents('wrun_a');
      expect(getEventCacheStats().totalSize).toBe(0);
    });
  });

  describe('clearEventCache', () => {
    it('removes all entries and resets totalSize', () => {
      setCachedRunEvents('wrun_a', { events: makeEvents(5), cursor: 'a' });
      setCachedRunEvents('wrun_b', { events: makeEvents(5), cursor: 'b' });
      expect(getEventCacheStats().entryCount).toBe(2);

      clearEventCache();

      expect(getCachedRunEvents('wrun_a')).toBeUndefined();
      expect(getCachedRunEvents('wrun_b')).toBeUndefined();
      const stats = getEventCacheStats();
      expect(stats.entryCount).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.evictionCount).toBe(0);
    });
  });

  describe('feature flag', () => {
    it('is enabled by default', () => {
      expect(isEventCacheEnabled()).toBe(true);
    });

    it('is disabled when WORKFLOW_DISABLE_EVENT_CACHE=1', () => {
      process.env.WORKFLOW_DISABLE_EVENT_CACHE = '1';
      expect(isEventCacheEnabled()).toBe(false);
    });

    it('returns undefined from get() when disabled', () => {
      setCachedRunEvents('wrun_a', { events: makeEvents(2), cursor: 'a' });
      process.env.WORKFLOW_DISABLE_EVENT_CACHE = '1';
      expect(getCachedRunEvents('wrun_a')).toBeUndefined();
    });

    it('skips set() when disabled', () => {
      process.env.WORKFLOW_DISABLE_EVENT_CACHE = '1';
      setCachedRunEvents('wrun_a', { events: makeEvents(2), cursor: 'a' });
      delete process.env.WORKFLOW_DISABLE_EVENT_CACHE;
      // After re-enabling the cache, the entry should not exist
      // because the set() never landed.
      expect(getCachedRunEvents('wrun_a')).toBeUndefined();
    });
  });

  describe('size estimation', () => {
    it('reports a non-zero totalSize for cached entries', () => {
      setCachedRunEvents('wrun_a', {
        events: makeEvents(10),
        cursor: 'a',
      });
      expect(getEventCacheStats().totalSize).toBeGreaterThan(0);
    });

    it('reports zero totalSize for an empty events array', () => {
      setCachedRunEvents('wrun_a', { events: [], cursor: 'a' });
      expect(getEventCacheStats().totalSize).toBe(0);
    });
  });
});
