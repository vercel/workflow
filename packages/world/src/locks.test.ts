import { describe, expect, test } from 'vitest';
import {
  CreateEventSchema,
  classifyEntityEvent,
  EventSchema,
  isLockEventType,
  TERMINAL_EVENT_CLASSES,
} from './events.js';
import {
  LOCK_BACKSTOP_MS,
  LOCK_RETRY_CAP_MS,
  LOCK_RETRY_MIN_MS,
  LockSchema,
  lockBackstopAt,
  lockRetryAt,
  lockRetryDelayMs,
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

  test('lockRetryAt is one schedule per scope, the same for every observer', () => {
    const since = 1_000_000;
    const first = lockRetryAt('wrun_a:lock_1', since, since);
    // Anyone asking inside the same window gets the same instant.
    expect(lockRetryAt('wrun_a:lock_1', since, since + 1)).toBe(first);
    expect(lockRetryAt('wrun_a:lock_1', since, first - 1)).toBe(first);
    // Past it, the next point, strictly later.
    const second = lockRetryAt('wrun_a:lock_1', since, first);
    expect(second).toBeGreaterThan(first);
    // Another scope draws its own jitter.
    const others = new Set(
      Array.from({ length: 20 }, (_, i) =>
        lockRetryAt(`wrun_a:lock_${i}`, since, since + 10_000)
      )
    );
    expect(others.size).toBeGreaterThan(10);
  });

  test('lockRetryAt backs off to the cap and stays strictly increasing', () => {
    const since = 0;
    let previous = since;
    let now = since;
    const gaps: number[] = [];
    for (let i = 0; i < 400; i++) {
      const next = lockRetryAt('s', since, now);
      expect(next).toBeGreaterThan(now);
      expect(next).toBeGreaterThan(previous);
      gaps.push(next - previous);
      previous = next;
      now = next;
    }
    expect(Math.max(...gaps)).toBeLessThan(2 * LOCK_RETRY_CAP_MS);
    // Hours in, the next point is found without walking the schedule.
    const late = lockRetryAt('s', since, 7 * 24 * 3_600_000);
    expect(late - 7 * 24 * 3_600_000).toBeLessThan(2 * LOCK_RETRY_CAP_MS);
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

describe('lock backstop', () => {
  const P = LOCK_BACKSTOP_MS;

  test('one point per period-wide window, the same for every attempt in it', () => {
    const since = 1_000_000;
    const first = lockBackstopAt('wrun_1:lock_1', since, since);
    expect(first).toBeGreaterThan(since);
    expect(first).toBeLessThanOrEqual(since + P);
    // Every attempt before the point (short of the 1s floor) gets the same
    // point: duplicate wakes collapse onto one retry message.
    for (const now of [
      since + 1,
      Math.floor((since + first) / 2),
      first - LOCK_RETRY_MIN_MS,
    ]) {
      expect(lockBackstopAt('wrun_1:lock_1', since, now)).toBe(first);
    }
    const second = lockBackstopAt('wrun_1:lock_1', since, first);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(since + 2 * P);
  });

  test('scopes are jittered independently', () => {
    const points = new Set(
      Array.from({ length: 20 }, (_, i) =>
        lockBackstopAt(`wrun_${i}:lock_1`, 0, 0)
      )
    );
    expect(points.size).toBeGreaterThan(15);
  });
});

describe('lock waitlist schemas', () => {
  test('a lock row without waitlist fields still parses', () => {
    const row = LockSchema.parse({
      key: 'k',
      concurrency: 2,
      count: 1,
      grantSeq: 4,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(row.queuedCount ?? 0).toBe(0);
    expect(row.reservedCount ?? 0).toBe(0);
  });

  test('lock_failed is a World-only lock event', () => {
    expect(isLockEventType('lock_failed')).toBe(true);
    expect(
      EventSchema.safeParse({
        eventType: 'lock_failed',
        correlationId: 'lock_1',
        runId: 'wrun_1',
        eventId: 'evnt_1',
        createdAt: new Date(),
        eventData: { key: 'k', concurrency: 1, reason: 'waitlist_full' },
      }).success
    ).toBe(true);
    expect(
      CreateEventSchema.safeParse({
        eventType: 'lock_failed',
        correlationId: 'lock_1',
        eventData: { key: 'k', concurrency: 1, reason: 'waitlist_full' },
      }).success
    ).toBe(false);
  });
});
