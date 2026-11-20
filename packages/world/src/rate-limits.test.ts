import { describe, expect, it } from 'vitest';
import {
  assertRateLimitKeyAllowed,
  decideRateLimit,
  decideRateWake,
  MAX_RATE_PERIOD_MS,
  RATE_GRACE_FLOOR_MS,
  RATE_GRACE_MAX_MS,
  RATE_MAX_LATE_WAKES,
  RESERVED_RATE_LIMIT_KEY_PREFIX,
  rateGraceMs,
  rateLateAdmitMaxMs,
  rateLimitIntervalUs,
  rateLimitToleranceUs,
  validateRateLimitCall,
} from './rate-limits.js';

describe('validateRateLimitCall', () => {
  const ok = { key: 'openai', limit: 10, periodMs: 1_000 };

  it('accepts a well-formed call', () => {
    expect(() => validateRateLimitCall(ok)).not.toThrow();
    expect(() =>
      validateRateLimitCall({ ...ok, periodMs: MAX_RATE_PERIOD_MS })
    ).not.toThrow();
  });

  it.each([
    [{ key: '' }, /non-empty/],
    [{ key: 'x'.repeat(513) }, /513 bytes/],
    // Counted in UTF-8 bytes, not characters.
    [{ key: '€'.repeat(171) }, /513 bytes/],
    [{ limit: 0 }, /positive integer/],
    [{ limit: 1.5 }, /positive integer/],
    [{ periodMs: 0 }, /positive whole number/],
    [{ periodMs: 0.5 }, /positive whole number/],
    [{ periodMs: MAX_RATE_PERIOD_MS + 1 }, /24 hours/],
    [{ burst: 0 }, /burst must be an integer from 1 to the limit/],
    [{ burst: 11 }, /burst must be an integer from 1 to the limit \(10\)/],
    [{ burst: 1.5 }, /burst must be/],
  ])('refuses %o', (bad, message) => {
    expect(() => validateRateLimitCall({ ...ok, ...bad })).toThrow(message);
  });
});

describe('assertRateLimitKeyAllowed', () => {
  it('reserves the $ namespace unless the call opts in', () => {
    expect(() =>
      assertRateLimitKeyAllowed('$workflow.agent', undefined)
    ).toThrow(/reserved prefix "\$"/);
    expect(() => assertRateLimitKeyAllowed('$x', false)).toThrow(RangeError);
    expect(() => assertRateLimitKeyAllowed('$x', true)).not.toThrow();
    // Only a leading $ is reserved.
    expect(() => assertRateLimitKeyAllowed('openai$', undefined)).not.toThrow();
    expect(() => assertRateLimitKeyAllowed('openai', undefined)).not.toThrow();
    expect(RESERVED_RATE_LIMIT_KEY_PREFIX).toBe('$');
  });
});

describe('rateLimitIntervalUs', () => {
  it('rounds up, so a period never holds more than the limit', () => {
    expect(rateLimitIntervalUs({ key: 'k', limit: 400, periodMs: 1_000 })).toBe(
      2_500
    );
    expect(rateLimitIntervalUs({ key: 'k', limit: 3, periodMs: 1_000 })).toBe(
      333_334
    );
  });

  it('is never 0', () => {
    expect(
      rateLimitIntervalUs({ key: 'k', limit: 10_000_000, periodMs: 1 })
    ).toBe(1);
  });
});

describe('decideRateLimit', () => {
  const T = 100;

  it('admits an idle key at once', () => {
    expect(
      decideRateLimit({
        tatUs: undefined,
        intervalUs: T,
        nowUs: 1_000,
        deadlineUs: 1_000,
      })
    ).toEqual({ status: 'reserved', acquireAtUs: 1_000, tatUs: 1_100 });
    // A tat in the past is an idle key too.
    expect(
      decideRateLimit({
        tatUs: 500,
        intervalUs: T,
        nowUs: 1_000,
        deadlineUs: 0,
      }).status
    ).toBe('deadline_exceeded');
  });

  it('spaces a burst exactly T apart', () => {
    let tatUs: number | undefined;
    const slots: number[] = [];
    for (let i = 0; i < 5; i++) {
      const decision = decideRateLimit({
        tatUs,
        intervalUs: T,
        nowUs: 1_000,
        deadlineUs: 10_000,
      });
      if (decision.status !== 'reserved') throw new Error('refused');
      slots.push(decision.acquireAtUs);
      tatUs = decision.tatUs;
    }
    expect(slots).toEqual([1_000, 1_100, 1_200, 1_300, 1_400]);
  });

  it('refuses past the deadline and reserves nothing', () => {
    expect(
      decideRateLimit({
        tatUs: 2_000,
        intervalUs: T,
        nowUs: 1_000,
        deadlineUs: 1_999,
      })
    ).toEqual({ status: 'deadline_exceeded', wouldAcquireAtUs: 2_000 });
  });

  it('narrows a far-future deadline so tat stays a safe integer', () => {
    const intervalUs = 1_000;
    const decision = decideRateLimit({
      tatUs: Number.MAX_SAFE_INTEGER - 10,
      intervalUs,
      nowUs: 0,
      deadlineUs: 8.64e15 * 1_000,
    });
    expect(decision.status).toBe('deadline_exceeded');
  });
});

describe('rateGraceMs', () => {
  it('is a tenth of the period, between the floor and the max', () => {
    expect(rateGraceMs(60_000)).toBe(6_000);
    expect(rateGraceMs(1_000)).toBe(RATE_GRACE_FLOOR_MS);
    expect(rateGraceMs(24 * 60 * 60 * 1000)).toBe(RATE_GRACE_MAX_MS);
  });

  it('doubles on each late wake, up to four times the first', () => {
    expect([0, 1, 2, 3, 10].map((k) => rateGraceMs(60_000, k))).toEqual([
      6_000, 12_000, 24_000, 24_000, 24_000,
    ]);
    // The max bounds the first grace, not the doubled ones.
    expect(rateGraceMs(24 * 60 * 60 * 1000, 2)).toBe(4 * RATE_GRACE_MAX_MS);
  });
});

describe('decideRateWake', () => {
  const NOW_MS = 1_900_000_000_000;
  const wake = (
    lateWakes: number,
    lateByMs: number,
    expiresAt = new Date(NOW_MS + 30 * 24 * 60 * 60 * 1000)
  ) =>
    decideRateWake({
      acquireAt: new Date(NOW_MS),
      nowMs: NOW_MS + lateByMs,
      periodMs: 60_000,
      lateWakes,
      expiresAt,
    });
  // A minute's graces are 6, 12 and 24 s, and its ceiling 84 s.
  const ceilingMs = rateLateAdmitMaxMs(60_000);

  it('goes ahead within its grace, at any count', () => {
    expect(RATE_MAX_LATE_WAKES).toBe(2);
    expect(ceilingMs).toBe(84_000);
    expect(wake(0, 6_000)).toBe('acquire');
    expect(wake(1, 12_000)).toBe('acquire');
    expect(wake(2, 24_000)).toBe('acquire');
  });

  it('is reserved again past its grace while the grace can still grow', () => {
    expect(wake(0, 6_001)).toBe('reserve_again');
    expect(wake(1, 24 * 60 * 60 * 1000)).toBe('reserve_again');
  });

  it('goes ahead late at the largest grace, up to the ceiling', () => {
    expect(wake(2, 24_001)).toBe('acquire_late');
    expect(wake(2, ceilingMs)).toBe('acquire_late');
    expect(wake(2, ceilingMs + 1)).toBe('reserve_again');
  });

  it('fails a late admission past the deadline rather than going ahead', () => {
    const expiresAt = new Date(NOW_MS + 10_000);
    expect(wake(2, 24_001, expiresAt)).toBe('fail');
    expect(wake(2, 24_000, expiresAt)).toBe('acquire');
  });
});

describe('burst', () => {
  // 10 per minute: T = 6 s.
  const call = { key: 'k', limit: 10, periodMs: 60_000 };
  const T = 6_000_000;
  const NOW = 1_900_000_000_000_000;

  /** Reserves one call per arrival, in order, and returns their slots. */
  function slotsFor(arrivalsUs: number[], burst?: number) {
    let tatUs: number | undefined;
    const withBurst = { ...call, ...(burst && { burst }) };
    return arrivalsUs.map((nowUs) => {
      const decision = decideRateLimit({
        tatUs,
        intervalUs: rateLimitIntervalUs(withBurst),
        toleranceUs: rateLimitToleranceUs(withBurst),
        nowUs,
        deadlineUs: nowUs + 3_600_000_000,
      });
      if (decision.status !== 'reserved') throw new Error('refused');
      tatUs = decision.tatUs;
      return decision.acquireAtUs;
    });
  }

  it('is (burst - 1) intervals, 0 without one', () => {
    expect(rateLimitToleranceUs(call)).toBe(0);
    expect(rateLimitToleranceUs({ ...call, burst: 1 })).toBe(0);
    expect(rateLimitToleranceUs({ ...call, burst: 10 })).toBe(9 * T);
  });

  it('is never more than the period, even when T rounds up', () => {
    const huge = { key: 'k', limit: Number.MAX_SAFE_INTEGER, periodMs: 1 };
    expect(rateLimitIntervalUs(huge)).toBe(1);
    expect(
      rateLimitToleranceUs({ ...huge, burst: Number.MAX_SAFE_INTEGER })
    ).toBe(1_000);
  });

  it('admits a full burst at once on an idle key, then one per interval', () => {
    const slots = slotsFor(Array(12).fill(NOW), 10);
    expect(slots.slice(0, 10)).toEqual(Array(10).fill(NOW));
    expect(slots[10]).toBe(NOW + T);
    expect(slots[11]).toBe(NOW + 2 * T);
  });

  it('spaces calls T apart without a burst, as before', () => {
    expect(slotsFor([NOW, NOW, NOW])).toEqual([NOW, NOW + T, NOW + 2 * T]);
  });

  it('refills one call per interval, never past the burst', () => {
    // A full burst, then an hour idle: still only `burst` go at once.
    const slots = slotsFor(
      [...Array(10).fill(NOW), ...Array(11).fill(NOW + 3_600_000_000)],
      10
    );
    const later = slots.slice(10);
    expect(later.slice(0, 10)).toEqual(Array(10).fill(NOW + 3_600_000_000));
    expect(later[10]).toBe(NOW + 3_600_000_000 + T);
  });

  it('measures the deadline from tat - τ', () => {
    const withBurst = { ...call, burst: 3 };
    const decision = decideRateLimit({
      tatUs: NOW + 2 * T,
      intervalUs: rateLimitIntervalUs(withBurst),
      toleranceUs: rateLimitToleranceUs(withBurst),
      nowUs: NOW,
      // Before tat, but at tat - τ: the slot is now, within it.
      deadlineUs: NOW,
    });
    expect(decision).toEqual({
      status: 'reserved',
      acquireAtUs: NOW,
      tatUs: NOW + 3 * T,
    });
  });
});
