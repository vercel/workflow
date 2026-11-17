import { describe, expect, it } from 'vitest';
import {
  formatRelativeTime,
  formatRelativeTimeDetailed,
  formatTime,
  formatTimestamp,
  formatTimestampSegments,
  formatZonedDateTime,
  getEventTimestamp,
  highResTimeToMs,
  parseDateValue,
} from './time';

// Every formatter takes the locale and time zone explicitly here, so results
// don't depend on the machine running the tests.
const US_UTC = { locale: 'en-US', timeZone: 'UTC' } as const;

// Newer ICU versions put a narrow no-break space before AM/PM.
const normalizeSpaces = (text: string) => text.replace(/\s/g, ' ');

const DATE = new Date('2026-03-16T12:34:56.789Z');

describe('parseDateValue', () => {
  it('accepts Dates, epoch milliseconds and date strings', () => {
    expect(parseDateValue(DATE)).toBe(DATE);
    expect(parseDateValue(DATE.getTime())?.toISOString()).toBe(
      DATE.toISOString()
    );
    expect(parseDateValue(0)?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(parseDateValue('2026-03-16T12:34:56.789Z')?.toISOString()).toBe(
      DATE.toISOString()
    );
  });

  it('returns null for missing, blank or invalid values', () => {
    expect(parseDateValue(null)).toBeNull();
    expect(parseDateValue(undefined)).toBeNull();
    expect(parseDateValue('')).toBeNull();
    expect(parseDateValue('   ')).toBeNull();
    expect(parseDateValue('not a date')).toBeNull();
    expect(parseDateValue(new Date(Number.NaN))).toBeNull();
    expect(parseDateValue(Number.NaN)).toBeNull();
  });
});

describe('getEventTimestamp', () => {
  const createdAt = new Date('2026-03-16T00:00:01.000Z');
  const occurredAt = new Date('2026-03-16T00:00:00.050Z');

  it('prefers occurredAt and falls back to createdAt', () => {
    expect(getEventTimestamp({ occurredAt, createdAt })).toBe(occurredAt);
    expect(getEventTimestamp({ createdAt })).toBe(createdAt);
    expect(
      getEventTimestamp({ createdAt: '2026-03-16T00:00:01.000Z' })?.getTime()
    ).toBe(createdAt.getTime());
  });

  it('returns undefined without a parseable timestamp', () => {
    expect(getEventTimestamp(undefined)).toBeUndefined();
    expect(getEventTimestamp({ createdAt: 'garbage' })).toBeUndefined();
  });
});

describe('highResTimeToMs', () => {
  it('converts [seconds, nanoseconds] to milliseconds', () => {
    expect(highResTimeToMs([0, 0])).toBe(0);
    expect(highResTimeToMs([1, 500_000_000])).toBe(1_500);
    expect(highResTimeToMs([1_773_664_496, 789_000_000])).toBe(DATE.getTime());
    expect(highResTimeToMs([0, 1_500])).toBeCloseTo(0.0015);
  });
});

describe('formatTimestamp', () => {
  it('shows the date, time to the millisecond and time zone', () => {
    expect(normalizeSpaces(formatTimestamp(DATE, US_UTC))).toBe(
      'Mar 16, 2026, 12:34:56.789 PM UTC'
    );
  });

  it('shows milliseconds, not hundredths', () => {
    const date = new Date('2026-03-16T12:34:56.007Z');
    expect(formatTimestamp(date, US_UTC)).toContain('56.007');
  });

  it('follows the locale and time zone', () => {
    expect(
      normalizeSpaces(
        formatTimestamp(DATE, { locale: 'en-GB', timeZone: 'Asia/Tokyo' })
      )
    ).toBe('16 Mar 2026, 21:34:56.789 GMT+9');
  });
});

describe('formatTime', () => {
  it('shows the time of day to the millisecond', () => {
    expect(normalizeSpaces(formatTime(DATE, US_UTC))).toBe('12:34:56.789 PM');
  });

  it('follows the locale and time zone', () => {
    expect(
      formatTime(DATE, { locale: 'de-DE', timeZone: 'America/New_York' })
    ).toBe('8:34:56,789');
  });
});

describe('formatTimestampSegments', () => {
  it('separates the date and fraction from the clock', () => {
    expect(
      formatTimestampSegments(DATE, US_UTC).map((segment) => ({
        ...segment,
        text: normalizeSpaces(segment.text),
      }))
    ).toEqual([
      { text: 'Mar 16, ', secondary: true },
      { text: '12:34:56', secondary: false },
      { text: '.789 ', secondary: true },
      { text: 'PM', secondary: false },
    ]);
  });

  it('pads the hour so rows line up', () => {
    const morning = new Date('2026-03-16T03:04:05.006Z');
    expect(
      normalizeSpaces(
        formatTimestampSegments(morning, US_UTC)
          .map((segment) => segment.text)
          .join('')
      )
    ).toBe('Mar 16, 03:04:05.006 AM');
  });

  it('follows the locale', () => {
    const segments = formatTimestampSegments(DATE, {
      locale: 'de-DE',
      timeZone: 'UTC',
    });
    expect(segments.find((s) => s.text.includes('12:34:56'))?.secondary).toBe(
      false
    );
    expect(segments.find((s) => s.text.includes('789'))?.text).toBe(',789');
    expect(segments.find((s) => s.text.includes('789'))?.secondary).toBe(true);
  });
});

describe('formatZonedDateTime', () => {
  it('formats a timestamp as read in a time zone', () => {
    expect(formatZonedDateTime(DATE, 'UTC', { locale: 'en-US' })).toMatchObject(
      { zone: 'UTC', date: 'March 16, 2026' }
    );
    const newYork = formatZonedDateTime(DATE, 'America/New_York', {
      locale: 'en-US',
    });
    expect(newYork.zone).toBe('EDT');
    expect(normalizeSpaces(newYork.time)).toBe('08:34:56 AM');
  });
});

describe('formatRelativeTime', () => {
  const now = DATE.getTime();
  const at = (offsetMs: number) => new Date(now + offsetMs);

  it('uses the largest whole unit', () => {
    expect(formatRelativeTime(at(-45_000), { now, locale: 'en-US' })).toBe(
      '45 seconds ago'
    );
    expect(formatRelativeTime(at(-119_000), { now, locale: 'en-US' })).toBe(
      '1 minute ago'
    );
    expect(
      formatRelativeTime(at(-3 * 86_400_000 - 5_000), { now, locale: 'en-US' })
    ).toBe('3 days ago');
  });

  it('describes future times', () => {
    expect(
      formatRelativeTime(at(2 * 3_600_000 + 1), { now, locale: 'en-US' })
    ).toBe('in 2 hours');
  });

  it('reads "now" under a second', () => {
    expect(formatRelativeTime(at(-500), { now, locale: 'en-US' })).toBe('now');
  });

  it('follows the locale', () => {
    expect(
      formatRelativeTime(at(-3 * 86_400_000), { now, locale: 'de-DE' })
    ).toBe('vor 3 Tagen');
  });
});

describe('formatRelativeTimeDetailed', () => {
  const now = DATE.getTime();
  const at = (offsetMs: number) => new Date(now + offsetMs);

  it('uses up to three units', () => {
    expect(
      formatRelativeTimeDetailed(at(-(2 * 3_600_000 + 15 * 60_000 + 30_000)), {
        now,
      })
    ).toBe('2 hours, 15 minutes, 30 seconds ago');
  });

  it('describes future times', () => {
    expect(
      formatRelativeTimeDetailed(at(3 * 86_400_000 + 5 * 60_000), { now })
    ).toBe('in 3 days, 0 hours, 5 minutes');
  });

  it('reads "Just now" under a second', () => {
    expect(formatRelativeTimeDetailed(at(-999), { now })).toBe('Just now');
  });
});
