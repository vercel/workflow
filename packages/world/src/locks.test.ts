import { describe, expect, test } from 'vitest';
import {
  CreateEventSchema,
  classifyEntityEvent,
  EventSchema,
  TERMINAL_EVENT_CLASSES,
} from './events.js';
import {
  LOCK_RETRY_CAP_MS,
  LOCK_RETRY_MIN_MS,
  lockRetryDelayMs,
  lockRetryDelayMsForWait,
} from './locks.js';

describe('lock retry backoff', () => {
  test('full jitter within [min, min(cap, base * 2^attempt))', () => {
    // The first attempt's window is the floor itself.
    expect(lockRetryDelayMs(0, { random: () => 0.999 })).toBe(
      LOCK_RETRY_MIN_MS
    );
    expect(lockRetryDelayMs(0, { random: () => 0 })).toBe(LOCK_RETRY_MIN_MS);
    expect(lockRetryDelayMs(1, { random: () => 0.75 })).toBe(1_500);
    expect(lockRetryDelayMs(3, { random: () => 0.5 })).toBe(4_000);
    expect(lockRetryDelayMs(40, { random: () => 0.999 })).toBeLessThan(
      LOCK_RETRY_CAP_MS
    );
  });

  test('derives the attempt from how long the scope has waited', () => {
    const max = { random: () => 0.999999 };
    expect(lockRetryDelayMsForWait(0, max)).toBe(LOCK_RETRY_MIN_MS);
    // Waited 3s: the attempt a 1s/2s/... waiter would be on is 2.
    expect(lockRetryDelayMsForWait(3_000, max)).toBeGreaterThan(3_000);
    expect(lockRetryDelayMsForWait(3_000, max)).toBeLessThan(4_000);
    expect(lockRetryDelayMsForWait(3_600_000, max)).toBeLessThan(
      LOCK_RETRY_CAP_MS
    );
  });
});

describe('lock event schemas', () => {
  const base = { runId: 'wrun_x', eventId: 'evnt_1', createdAt: new Date() };

  test('lock_acquired is readable but not creatable', () => {
    const acquired = {
      eventType: 'lock_acquired',
      correlationId: 'lock_a',
      eventData: {
        key: 'k',
        concurrency: 2,
        effectiveConcurrency: 2,
        fencingToken: 1,
      },
    };
    expect(EventSchema.safeParse({ ...acquired, ...base }).success).toBe(true);
    expect(CreateEventSchema.safeParse(acquired).success).toBe(false);
  });

  test('lock_created validates key and concurrency', () => {
    const ok = {
      eventType: 'lock_created',
      correlationId: 'lock_a',
      eventData: { key: 'stripe:cus_1', concurrency: 5 },
    };
    expect(CreateEventSchema.safeParse(ok).success).toBe(true);
    for (const eventData of [
      { key: '', concurrency: 1 },
      { key: 'k', concurrency: 0 },
      { key: 'k', concurrency: 1.5 },
      { key: 'x'.repeat(513), concurrency: 1 },
    ]) {
      expect(CreateEventSchema.safeParse({ ...ok, eventData }).success).toBe(
        false
      );
    }
  });

  test('lock events have entity classes and lock_released closes the scope', () => {
    for (const eventType of [
      'lock_created',
      'lock_acquired',
      'lock_released',
    ]) {
      expect(
        classifyEntityEvent({ eventType, correlationId: 'lock_a' })
      ).toEqual({ eventClass: eventType, entity: 'lock_a' });
    }
    expect(TERMINAL_EVENT_CLASSES.has('lock_released')).toBe(true);
  });
});
