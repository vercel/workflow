import { describe, expect, it } from 'vitest';
import {
  decideRateLimit,
  MAX_RATE_PERIOD_MS,
  rateLimitIntervalUs,
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
    [{ periodMs: MAX_RATE_PERIOD_MS + 1 }, /365 days/],
  ])('refuses %o', (bad, message) => {
    expect(() => validateRateLimitCall({ ...ok, ...bad })).toThrow(message);
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
