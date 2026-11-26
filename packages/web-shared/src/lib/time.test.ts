import { describe, expect, it, vi } from 'vitest';
import {
  formatDuration,
  formatElapsed,
  formatPreciseDuration,
  formatShortTimeAgo,
  formatShortUnit,
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

describe('formatShortUnit', () => {
  it('rounds to the largest unit', () => {
    expect(formatShortUnit(45 * SECOND)).toBe('45s');
    expect(formatShortUnit(2 * MINUTE + 3 * SECOND)).toBe('2m');
    expect(formatShortUnit(3 * HOUR + 12 * MINUTE)).toBe('3h');
    expect(formatShortUnit(12 * HOUR)).toBe('12h');
    expect(formatShortUnit(7 * DAY + 18 * HOUR)).toBe('8d');
    expect(formatShortUnit(30 * DAY)).toBe('30d');
  });

  it('carries rounding into the next unit', () => {
    expect(formatShortUnit(59_600)).toBe('1m');
    expect(formatShortUnit(59 * MINUTE + 40 * SECOND)).toBe('1h');
    expect(formatShortUnit(23 * HOUR + 40 * MINUTE)).toBe('1d');
  });
});

describe('formatDuration', () => {
  it('shows whole seconds, and 1s for anything shorter', () => {
    expect(formatDuration(0)).toBe('1s');
    expect(formatDuration(56)).toBe('1s');
    expect(formatDuration(857)).toBe('1s');
    expect(formatDuration(5970)).toBe('6s');
  });

  it('shows minutes and seconds under an hour', () => {
    expect(formatDuration(59_600)).toBe('1m');
    expect(formatDuration(2 * MINUTE + 3 * SECOND)).toBe('2m 3s');
    expect(formatDuration(59 * MINUTE + 59 * SECOND)).toBe('59m 59s');
  });

  it('shows one rounded unit from an hour', () => {
    expect(formatDuration(HOUR - 400)).toBe('1h');
    expect(formatDuration(3 * HOUR + 12 * MINUTE)).toBe('3h');
    expect(formatDuration(7 * DAY + 18 * HOUR)).toBe('8d');
  });
});

describe('formatElapsed', () => {
  it('shows milliseconds under a second, and no sign on zero', () => {
    expect(formatElapsed(0)).toBe('0ms');
    expect(formatElapsed(12)).toBe('+12ms');
    expect(formatElapsed(776)).toBe('+776ms');
  });

  it('shows one decimal under ten seconds', () => {
    expect(formatElapsed(1010)).toBe('+1s');
    expect(formatElapsed(4700)).toBe('+4.7s');
    expect(formatElapsed(9960)).toBe('+10s');
  });

  it('shows the duration from ten seconds', () => {
    expect(formatElapsed(12_400)).toBe('+12s');
    expect(formatElapsed(2 * MINUTE + 3 * SECOND)).toBe('+2m 3s');
    expect(formatElapsed(3 * HOUR + 12 * MINUTE)).toBe('+3h');
  });
});

describe('formatPreciseDuration', () => {
  it('shows up to two decimals under a minute', () => {
    expect(formatPreciseDuration(0.4)).toBe('0.4ms');
    expect(formatPreciseDuration(62)).toBe('62ms');
    expect(formatPreciseDuration(857)).toBe('857ms');
    expect(formatPreciseDuration(1010)).toBe('1.01s');
    expect(formatPreciseDuration(5970)).toBe('5.97s');
  });

  it('reads zero as 0', () => {
    expect(formatPreciseDuration(0)).toBe('0');
    expect(formatPreciseDuration(0.001)).toBe('0');
  });

  it('carries rounding into the next unit', () => {
    expect(formatPreciseDuration(999.999)).toBe('1s');
    expect(formatPreciseDuration(59_996)).toBe('1m');
  });

  it('shows the duration from a minute', () => {
    expect(formatPreciseDuration(2 * MINUTE + 3 * SECOND)).toBe('2m 3s');
    expect(formatPreciseDuration(7 * DAY + 18 * HOUR)).toBe('8d');
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
