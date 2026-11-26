import { describe, expect, it, vi } from 'vitest';
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  formatTimestampParts,
  getEventDate,
  parseDate,
} from './time';

vi.hoisted(() => {
  process.env.TZ = 'America/New_York';
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('parseDate', () => {
  it('parses dates, ISO strings and epoch milliseconds', () => {
    const date = new Date('2026-11-18T03:33:23.263Z');
    expect(parseDate(date)).toBe(date);
    expect(parseDate('2026-11-18T03:33:23.263Z')).toEqual(date);
    expect(parseDate(date.getTime())).toEqual(date);
  });

  it('returns null for missing and unparseable values', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(new Date(Number.NaN))).toBeNull();
  });
});

describe('getEventDate', () => {
  const createdAt = new Date('2026-11-18T03:33:24.000Z');

  it('prefers occurredAt', () => {
    const occurredAt = new Date('2026-11-18T03:33:23.263Z');
    expect(getEventDate({ createdAt, occurredAt })).toEqual(occurredAt);
  });

  it('falls back to createdAt', () => {
    expect(getEventDate({ createdAt })).toEqual(createdAt);
    expect(
      getEventDate({ createdAt, occurredAt: new Date(Number.NaN) })
    ).toEqual(createdAt);
  });
});

describe('formatTimestamp', () => {
  it('shows the local date and a 24h clock with milliseconds', () => {
    expect(formatTimestamp(new Date('2026-11-18T03:33:23.263Z'))).toBe(
      'Nov 17, 2026 22:33:23.263'
    );
    expect(formatTimestamp(new Date('2026-03-06T05:04:05.007Z'))).toBe(
      'Mar 6, 2026 00:04:05.007'
    );
  });

  it('splits a row timestamp into a padded day, clock and two fraction digits', () => {
    expect(formatTimestampParts(new Date('2026-03-06T05:04:05.267Z'))).toEqual({
      day: 'Mar 06',
      clock: '00:04:05',
      ms: '.26',
    });
  });
});

describe('formatDuration', () => {
  it('shows whole milliseconds below a second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(0.4)).toBe('0ms');
    expect(formatDuration(56)).toBe('56ms');
    expect(formatDuration(857)).toBe('857ms');
  });

  it('shows seconds with up to two decimals below a minute', () => {
    expect(formatDuration(999.6)).toBe('1s');
    expect(formatDuration(1626)).toBe('1.63s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(5970)).toBe('5.97s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(59_994)).toBe('59.99s');
  });

  it('shows whole seconds from a minute up and leaves out zero units', () => {
    expect(formatDuration(59_996)).toBe('1m');
    expect(formatDuration(63_450)).toBe('1m 3s');
    expect(formatDuration(2 * MINUTE + 3 * SECOND)).toBe('2m 3s');
    expect(formatDuration(HOUR + 5 * SECOND)).toBe('1h 5s');
    expect(formatDuration(3 * HOUR + 12 * MINUTE)).toBe('3h 12m');
    expect(formatDuration(2 * DAY)).toBe('2d');
    expect(formatDuration(7 * DAY + HOUR + 52 * MINUTE + 33_750)).toBe(
      '7d 1h 52m 34s'
    );
  });

  it('carries rounding into the next unit', () => {
    expect(formatDuration(999.5)).toBe('1s');
    expect(formatDuration(59_995)).toBe('1m');
    expect(formatDuration(119_999)).toBe('2m');
    expect(formatDuration(3_659_999)).toBe('1h 1m');
    expect(formatDuration(86_459_999)).toBe('1d 1m');
  });

  it('uses the given number of decimals on the seconds', () => {
    expect(formatDuration(500, 1)).toBe('500ms');
    expect(formatDuration(1620, 1)).toBe('1.6s');
    expect(formatDuration(1002, 3)).toBe('1.002s');
    expect(formatDuration(2 * MINUTE + 50, 2)).toBe('2m 0.05s');
    expect(formatDuration(2 * MINUTE, 2)).toBe('2m');
  });
});

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000_000;

  it('formats past dates in their largest unit', () => {
    expect(formatRelativeTime(NOW - 5 * SECOND, NOW)).toBe('5 seconds ago');
    expect(formatRelativeTime(NOW - (5 * MINUTE + 3 * SECOND), NOW)).toBe(
      '5 minutes ago'
    );
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe('1 hour ago');
    expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    expect(formatRelativeTime(NOW - 70 * DAY, NOW)).toBe('2 months ago');
    expect(formatRelativeTime(NOW - 800 * DAY, NOW)).toBe('2 years ago');
  });

  it('formats future dates', () => {
    expect(formatRelativeTime(NOW + 2 * HOUR, NOW)).toBe('in 2 hours');
  });

  it('reads sub-second differences as now', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('now');
    expect(formatRelativeTime(NOW - 400, NOW)).toBe('now');
    expect(formatRelativeTime(NOW + 400, NOW)).toBe('now');
  });
});
