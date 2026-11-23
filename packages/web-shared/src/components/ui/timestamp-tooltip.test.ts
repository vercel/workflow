import { describe, expect, it } from 'vitest';
import { formatShortTimeAgo, formatTimeAgo } from './timestamp-tooltip';

const NOW = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatTimeAgo', () => {
  it('formats past dates with "ago"', () => {
    expect(formatTimeAgo(NOW - (5 * MINUTE + 3 * SECOND), NOW)).toBe(
      '5 minutes, 3 seconds ago'
    );
  });

  it('formats future dates with "in"', () => {
    expect(formatTimeAgo(NOW + (5 * MINUTE + 3 * SECOND), NOW)).toBe(
      'in 5 minutes, 3 seconds'
    );
  });

  it('returns "Just now" for sub-second differences', () => {
    expect(formatTimeAgo(NOW, NOW)).toBe('Just now');
    expect(formatTimeAgo(NOW + 500, NOW)).toBe('Just now');
  });
});

describe('formatShortTimeAgo', () => {
  it('formats past dates with "ago"', () => {
    expect(formatShortTimeAgo(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    expect(formatShortTimeAgo(NOW - HOUR, NOW)).toBe('1 hour ago');
    expect(formatShortTimeAgo(NOW - 2 * MINUTE, NOW)).toBe('2 minutes ago');
    expect(formatShortTimeAgo(NOW - 10 * SECOND, NOW)).toBe('Just now');
  });

  it('formats future dates with "In"', () => {
    expect(formatShortTimeAgo(NOW + 3 * DAY, NOW)).toBe('In 3 days');
    expect(formatShortTimeAgo(NOW + HOUR, NOW)).toBe('In 1 hour');
    expect(formatShortTimeAgo(NOW + 2 * MINUTE, NOW)).toBe('In 2 minutes');
    expect(formatShortTimeAgo(NOW + 10 * SECOND, NOW)).toBe(
      'In less than a minute'
    );
  });
});
