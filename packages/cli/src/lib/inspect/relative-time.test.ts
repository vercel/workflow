import { formatDistance } from 'date-fns';
import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relative-time.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const reference = (date: Date, base: Date) =>
  formatDistance(date, base, { addSuffix: true });

/** Small deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('formatRelativeTime', () => {
  const base = new Date('2026-03-15T12:00:00.000Z');

  it.each([
    [0, 'less than a minute ago'],
    [-29 * SECOND, 'less than a minute ago'],
    [-30 * SECOND, '1 minute ago'],
    [-5 * MINUTE, '5 minutes ago'],
    [-45 * MINUTE, 'about 1 hour ago'],
    [-3 * HOUR, 'about 3 hours ago'],
    [-30 * HOUR, '1 day ago'],
    [-5 * DAY, '5 days ago'],
    [-40 * DAY, 'about 1 month ago'],
    [-100 * DAY, '3 months ago'],
    [-400 * DAY, 'about 1 year ago'],
    [-600 * DAY, 'over 1 year ago'],
    [-700 * DAY, 'almost 2 years ago'],
    [5 * MINUTE, 'in 5 minutes'],
    [3 * HOUR, 'in about 3 hours'],
  ])('%d ms from now reads %j', (offset, expected) => {
    const date = new Date(base.getTime() + offset);
    expect(formatRelativeTime(date, base)).toBe(expected);
    expect(reference(date, base)).toBe(expected);
  });

  it('matches date-fns formatDistance on randomized distances', () => {
    const random = rng(0x5eed);
    // Spread distances log-uniformly from a second to ~30 years, both
    // directions, around bases spread across several years (month ends,
    // leap days and DST changes included).
    for (let i = 0; i < 20_000; i++) {
      const baseMs =
        Date.UTC(2020, 0, 1) + Math.floor(random() * 10 * 365 * DAY);
      const magnitude = Math.exp(random() * Math.log(30 * 365 * DAY));
      const sign = random() < 0.5 ? -1 : 1;
      const b = new Date(baseMs);
      const d = new Date(baseMs + sign * Math.floor(magnitude));
      expect(
        formatRelativeTime(d, b),
        `${d.toISOString()} vs ${b.toISOString()}`
      ).toBe(reference(d, b));
    }
  });

  it('matches date-fns around month ends', () => {
    for (const [from, to] of [
      ['2024-01-31T10:00:00Z', '2025-02-28T10:00:00Z'],
      ['2024-01-31T10:00:00Z', '2025-02-28T09:59:59Z'],
      ['2024-02-29T00:00:00Z', '2025-02-28T00:00:00Z'],
      ['2023-03-31T12:00:00Z', '2023-06-30T12:00:00Z'],
      ['2023-05-31T23:59:59Z', '2024-02-29T23:59:59Z'],
      ['2021-12-31T00:00:00Z', '2023-12-30T23:00:00Z'],
    ]) {
      const a = new Date(from);
      const b = new Date(to);
      expect(formatRelativeTime(a, b)).toBe(reference(a, b));
      expect(formatRelativeTime(b, a)).toBe(reference(b, a));
    }
  });
});
