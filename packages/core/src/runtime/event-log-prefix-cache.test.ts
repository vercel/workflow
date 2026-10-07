import {
  type Event,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  slotToEventId,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cacheablePrefix,
  EVENT_LOG_PREFIX_CACHE_IDLE_TTL_MS,
  EventLogPrefixCache,
  estimateEventBytes,
  eventLogPrefixCacheLimits,
  isEventLogPrefixCacheEnabled,
} from './event-log-prefix-cache.js';

const runId = 'wrun_prefix_cache_unit';

function event(
  slot: number,
  eventType: string,
  extra: Partial<Event> & { eventData?: unknown } = {}
): Event {
  return {
    runId,
    eventId: slotToEventId(slot),
    eventType,
    specVersion: SPEC_VERSION_CURRENT,
    createdAt: new Date(1_700_000_000_000 + slot),
    ...extra,
  } as Event;
}

/** run_created, run_started, then `steps` step_created events. */
function log(steps: number, payloadBytes = 0): Event[] {
  return [
    event(1, 'run_created', {
      eventData: { input: new Uint8Array(payloadBytes) },
    }),
    event(2, 'run_started'),
    ...Array.from({ length: steps }, (_, index) =>
      event(3 + index, 'step_created', {
        correlationId: `step_${index}`,
        eventData: { input: new Uint8Array(payloadBytes) },
      })
    ),
  ];
}

const slots = (events: readonly Event[] | undefined) =>
  events?.map((e) => e.eventId);

describe('isEventLogPrefixCacheEnabled', () => {
  it('is off by default and on only for 1 / true', () => {
    expect(isEventLogPrefixCacheEnabled({})).toBe(false);
    expect(
      isEventLogPrefixCacheEnabled({ WORKFLOW_EVENT_LOG_PREFIX_CACHE: '' })
    ).toBe(false);
    expect(
      isEventLogPrefixCacheEnabled({ WORKFLOW_EVENT_LOG_PREFIX_CACHE: '0' })
    ).toBe(false);
    expect(
      isEventLogPrefixCacheEnabled({ WORKFLOW_EVENT_LOG_PREFIX_CACHE: '1' })
    ).toBe(true);
    expect(
      isEventLogPrefixCacheEnabled({ WORKFLOW_EVENT_LOG_PREFIX_CACHE: 'TRUE' })
    ).toBe(true);
  });

  it('reads byte limits with defaults for missing or invalid values', () => {
    expect(eventLogPrefixCacheLimits({})).toMatchObject({
      maxBytes: 32 * 1024 * 1024,
      minBytes: 16 * 1024,
    });
    expect(
      eventLogPrefixCacheLimits({
        WORKFLOW_EVENT_LOG_PREFIX_CACHE_MAX_BYTES: '1000',
        WORKFLOW_EVENT_LOG_PREFIX_CACHE_MIN_BYTES: 'nope',
      })
    ).toMatchObject({ maxBytes: 1000, minBytes: 16 * 1024 });
  });
});

describe('cacheablePrefix (the fill rules)', () => {
  it('takes the dense run of slots from 1, whatever order the log is in', () => {
    const events = log(3);
    expect(slots(cacheablePrefix([...events].reverse()))).toEqual(
      slots(events)
    );
  });

  it('stops at the first hole (CacheDenseOnly)', () => {
    const events = log(4);
    const holey = events.filter((e) => e.eventId !== slotToEventId(4));
    expect(slots(cacheablePrefix(holey))).toEqual(slots(events.slice(0, 3)));
  });

  it('requires slot 1 to be present (no floor exemption)', () => {
    expect(cacheablePrefix(log(3).slice(1))).toBeUndefined();
  });

  it('requires run_started inside the dense prefix (StartInPrefix)', () => {
    const events = log(2).filter((e) => e.eventType !== 'run_started');
    expect(cacheablePrefix(events)).toBeUndefined();
  });

  it('refuses runs below the sealed log', () => {
    const events = log(2);
    events[0] = {
      ...events[0],
      specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
    } as Event;
    expect(cacheablePrefix(events)).toBeUndefined();
  });

  it('refuses ULID-identified logs', () => {
    const events = log(2);
    events.push({
      ...event(9, 'step_created'),
      eventId: 'evnt_01K0000000000000000000000',
    } as Event);
    expect(cacheablePrefix(events)).toBeUndefined();
  });

  it('refuses a log that records the end of the run', () => {
    expect(
      cacheablePrefix([...log(2), event(5, 'run_completed')])
    ).toBeUndefined();
  });

  it('counts sealed noops as present', () => {
    const events = [...log(1), event(4, 'noop'), event(5, 'step_created')];
    expect(cacheablePrefix(events)).toHaveLength(5);
  });
});

describe('EventLogPrefixCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers nothing for an unknown run', () => {
    expect(
      EventLogPrefixCache.isolated({ minBytes: 0 }).offer(runId)
    ).toBeUndefined();
  });

  it('fills only from an invocation whose first load held run_started (StartInFirstLoad)', () => {
    const cache = EventLogPrefixCache.isolated({ minBytes: 0 });
    expect(cache.fill(runId, log(3), false)).toBe('ineligible');
    expect(cache.size).toBe(0);
    expect(cache.fill(runId, log(3), true)).toBe('filled');
    expect(slots(cache.offer(runId)?.events)).toEqual(slots(log(3)));
  });

  it('hands out detached copies: no aliasing between invocations or with the cache', () => {
    const cache = EventLogPrefixCache.isolated({ minBytes: 0 });
    const source = log(2);
    cache.fill(runId, source, true);
    // Mutating the invocation's log after the fill does not reach the cache.
    (source[2] as { correlationId?: string }).correlationId = 'mutated';
    const first = cache.offer(runId);
    const second = cache.offer(runId);
    expect(first?.events).not.toBe(second?.events);
    expect(first?.events[2]).not.toBe(second?.events[2]);
    expect(first?.events[2].correlationId).toBe('step_0');
    (
      first?.events[2] as { eventData: Record<string, unknown> }
    ).eventData.extra = 1;
    expect(
      (second?.events[2] as { eventData: Record<string, unknown> }).eventData
        .extra
    ).toBeUndefined();
    expect(
      (cache.offer(runId)?.events[2] as { eventData: Record<string, unknown> })
        .eventData.extra
    ).toBeUndefined();
  });

  it('keeps the longer of two prefixes (concurrent invocations of one run)', () => {
    const cache = EventLogPrefixCache.isolated({ minBytes: 0 });
    expect(cache.fill(runId, log(5), true)).toBe('filled');
    expect(cache.fill(runId, log(2), true)).toBe('kept_longer');
    expect(cache.offer(runId)?.events).toHaveLength(7);
    expect(cache.fill(runId, log(6), true)).toBe('filled');
    expect(cache.offer(runId)?.events).toHaveLength(8);
  });

  it('evicts on a terminal log', () => {
    const cache = EventLogPrefixCache.isolated({ minBytes: 0 });
    cache.fill(runId, log(2), true);
    expect(cache.fill(runId, [...log(2), event(5, 'run_failed')], true)).toBe(
      'evicted_terminal'
    );
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });

  it('does not offer a prefix below the claim floor, but keeps it', () => {
    const cache = EventLogPrefixCache.isolated({ minBytes: 10_000 });
    cache.fill(runId, log(2, 10), true);
    expect(cache.offer(runId)).toBeUndefined();
    expect(cache.size).toBe(1);
    cache.fill(runId, log(3, 5_000), true);
    expect(cache.offer(runId)?.events).toHaveLength(5);
  });

  it('expires idle entries', () => {
    vi.useFakeTimers();
    const cache = EventLogPrefixCache.isolated({ minBytes: 0 });
    cache.fill(runId, log(2), true);
    vi.advanceTimersByTime(EVENT_LOG_PREFIX_CACHE_IDLE_TTL_MS - 1);
    expect(cache.offer(runId)).toBeDefined();
    vi.advanceTimersByTime(EVENT_LOG_PREFIX_CACHE_IDLE_TTL_MS + 1);
    expect(cache.offer(runId)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('bounds the total budget by evicting least recently used runs', () => {
    const perRun = log(2, 1_000).reduce((n, e) => n + estimateEventBytes(e), 0);
    const cache = EventLogPrefixCache.isolated({
      minBytes: 0,
      maxBytes: perRun * 4,
    });
    cache.fill('wrun_a', log(2, 1_000), true);
    cache.fill('wrun_b', log(2, 1_000), true);
    cache.fill('wrun_c', log(2, 1_000), true);
    cache.offer('wrun_a'); // touch a: b is now least recently used
    cache.fill('wrun_d', log(2, 1_000), true);
    cache.fill('wrun_e', log(2, 1_000), true);
    expect(cache.totalBytes).toBeLessThanOrEqual(perRun * 4);
    expect(cache.offer('wrun_b')).toBeUndefined();
    expect(cache.offer('wrun_a')).toBeDefined();
    expect(cache.offer('wrun_e')).toBeDefined();
  });

  it('refuses an entry larger than a quarter of the budget', () => {
    const cache = EventLogPrefixCache.isolated({
      minBytes: 0,
      maxBytes: 4_000,
    });
    expect(cache.fill(runId, log(2, 1_000), true)).toBe('too_large');
    expect(cache.size).toBe(0);
  });

  it('evict forgets the run and its bytes', () => {
    const cache = EventLogPrefixCache.isolated({ minBytes: 0 });
    cache.fill(runId, log(2), true);
    cache.evict(runId);
    cache.evict(runId);
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });

  it('shares one cache across instances (bundled copies)', () => {
    const a = EventLogPrefixCache.shared();
    const b = EventLogPrefixCache.shared();
    a.clear();
    a.fill(runId, log(40, 1_000), true);
    expect(b.offer(runId)?.events).toHaveLength(42);
    a.clear();
  });
});
