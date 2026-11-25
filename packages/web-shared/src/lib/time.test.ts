import { describe, expect, it, vi } from 'vitest';
import {
  formatDuration,
  formatShortTimeAgo,
  formatTimeAgo,
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
  it('shows the local day and a 24h clock with two fraction digits', () => {
    const date = new Date('2026-11-18T03:33:23.263Z');
    expect(formatTimestamp(date)).toBe('Nov 17 22:33:23.26');
    expect(formatTimestampParts(date)).toEqual({
      day: 'Nov 17',
      clock: '22:33:23',
      ms: '.26',
    });
  });

  it('pads the day and reads midnight as 00', () => {
    expect(formatTimestamp(new Date('2026-03-06T05:04:05.007Z'))).toBe(
      'Mar 06 00:04:05.00'
    );
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

describe('formatTimeAgo', () => {
  const NOW = 1_700_000_000_000;

  it('formats past dates with up to three units', () => {
    expect(formatTimeAgo(NOW - (5 * MINUTE + 3 * SECOND), NOW)).toBe(
      '5 minutes, 3 seconds ago'
    );
    expect(
      formatTimeAgo(NOW - (7 * DAY + 18 * HOUR + 22 * MINUTE + 9 * SECOND), NOW)
    ).toBe('7 days, 18 hours, 22 minutes ago');
    expect(formatTimeAgo(NOW - (HOUR + SECOND), NOW)).toBe(
      '1 hour, 0 minutes, 1 second ago'
    );
  });

  it('formats future dates with "in"', () => {
    expect(formatTimeAgo(NOW + (5 * MINUTE + 3 * SECOND), NOW)).toBe(
      'in 5 minutes, 3 seconds'
    );
  });

  it('reads sub-second differences as "Just now"', () => {
    expect(formatTimeAgo(NOW, NOW)).toBe('Just now');
    expect(formatTimeAgo(NOW + 500, NOW)).toBe('Just now');
  });
});

describe('formatShortTimeAgo', () => {
  const NOW = 1_700_000_000_000;

  it('formats past dates in their largest unit', () => {
    expect(formatShortTimeAgo(NOW - 7 * DAY, NOW)).toBe('7 days ago');
    expect(formatShortTimeAgo(NOW - 400 * DAY, NOW)).toBe('400 days ago');
    expect(formatShortTimeAgo(NOW - (DAY + 5 * HOUR), NOW)).toBe('1 day ago');
    expect(formatShortTimeAgo(NOW - 5 * HOUR, NOW)).toBe('5 hours ago');
    expect(formatShortTimeAgo(NOW - 3 * MINUTE, NOW)).toBe('3 minutes ago');
  });

  it('formats future dates with "in"', () => {
    expect(formatShortTimeAgo(NOW + 3 * DAY, NOW)).toBe('in 3 days');
    expect(formatShortTimeAgo(NOW + HOUR, NOW)).toBe('in 1 hour');
  });

  it('reads differences under a minute as "Just now"', () => {
    expect(formatShortTimeAgo(NOW, NOW)).toBe('Just now');
    expect(formatShortTimeAgo(NOW - 59 * SECOND, NOW)).toBe('Just now');
    expect(formatShortTimeAgo(NOW + 10 * SECOND, NOW)).toBe('Just now');
  });
});
