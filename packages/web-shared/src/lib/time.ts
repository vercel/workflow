/**
 * Date and time parsing and formatting for the observability UI. Every
 * formatter follows the viewer's locale and time zone unless the caller
 * passes one, so a timestamp reads the same way on every surface.
 */

export interface DateFormatOptions {
  /** BCP 47 locale. Defaults to the runtime's locale. */
  locale?: string;
  /** IANA time zone. Defaults to the runtime's time zone. */
  timeZone?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────────

/**
 * Reads a timestamp from a `Date`, epoch milliseconds or a date string.
 * Returns `null` for missing, blank or unparseable values.
 */
export function parseDateValue(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && value.trim().length === 0) return null;

  const date =
    typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * When an event happened: its `occurredAt` when recorded, else its
 * `createdAt`. Returns `undefined` when the chosen value doesn't parse.
 */
export function getEventTimestamp(
  event: { occurredAt?: unknown; createdAt?: unknown } | undefined
): Date | undefined {
  return parseDateValue(event?.occurredAt ?? event?.createdAt) ?? undefined;
}

/**
 * Converts an OpenTelemetry high-resolution time, `[seconds, nanoseconds]`,
 * to epoch milliseconds.
 */
export function highResTimeToMs([seconds, nanoseconds]: readonly [
  number,
  number,
]): number {
  return seconds * 1_000 + nanoseconds / 1_000_000;
}

// ──────────────────────────────────────────────────────────────────────────
// Absolute timestamps
// ──────────────────────────────────────────────────────────────────────────

const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  timeZoneName: 'short',
};

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
};

/** Fixed-width for table columns: two-digit day and hour. */
const TABLE_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
};

const ZONE_NAME_FORMAT: Intl.DateTimeFormatOptions = { timeZoneName: 'short' };

const ZONE_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

const ZONE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

// Building a DateTimeFormat is far slower than using one, and timestamps are
// formatted per row, so keep one per format, locale and time zone.
const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(
  format: Intl.DateTimeFormatOptions,
  { locale, timeZone }: DateFormatOptions
): Intl.DateTimeFormat {
  const key = `${JSON.stringify(format)}|${locale ?? ''}|${timeZone ?? ''}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...format, timeZone });
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Full timestamp with milliseconds and time zone, e.g.
 * "Mar 16, 2026, 12:34:56.789 PM UTC" in `en-US`.
 */
export function formatTimestamp(
  date: Date,
  options: DateFormatOptions = {}
): string {
  return getFormatter(TIMESTAMP_FORMAT, options).format(date);
}

/** Time of day with milliseconds, e.g. "12:34:56.789 PM" in `en-US`. */
export function formatTime(
  date: Date,
  options: DateFormatOptions = {}
): string {
  return getFormatter(TIME_FORMAT, options).format(date);
}

export interface TimestampSegment {
  text: string;
  /** The day and the fraction of a second, which a table can de-emphasise. */
  secondary: boolean;
}

const DATE_PART_TYPES = new Set<Intl.DateTimeFormatPartTypes>([
  'era',
  'year',
  'month',
  'day',
  'weekday',
]);

/**
 * Compact timestamp for a table cell, e.g. "Mar 16, 12:34:56.789 PM" in
 * `en-US`, split into runs so the date and milliseconds can be styled apart
 * from the clock. Segment order follows the locale.
 */
export function formatTimestampSegments(
  date: Date,
  options: DateFormatOptions = {}
): TimestampSegment[] {
  const parts = getFormatter(TABLE_FORMAT, options).formatToParts(date);
  const segments: TimestampSegment[] = [];
  let previousSecondary = false;

  parts.forEach((part, i) => {
    const secondary =
      part.type === 'literal'
        ? // Separators follow the date, and lead into the fraction.
          previousSecondary || parts[i + 1]?.type === 'fractionalSecond'
        : DATE_PART_TYPES.has(part.type) || part.type === 'fractionalSecond';
    previousSecondary = secondary;

    const last = segments[segments.length - 1];
    if (last && last.secondary === secondary) {
      last.text += part.value;
    } else {
      segments.push({ text: part.value, secondary });
    }
  });

  return segments;
}

/**
 * A timestamp as read in one time zone: the zone's short name, the date and
 * the time to the second, e.g. `{ zone: 'UTC', date: 'March 16, 2026',
 * time: '12:34:56 PM' }` in `en-US`.
 */
export function formatZonedDateTime(
  date: Date,
  timeZone: string,
  { locale }: Pick<DateFormatOptions, 'locale'> = {}
): { zone: string; date: string; time: string } {
  const options = { locale, timeZone };
  const zone =
    getFormatter(ZONE_NAME_FORMAT, options)
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value || timeZone;
  return {
    zone,
    date: getFormatter(ZONE_DATE_FORMAT, options).format(date),
    time: getFormatter(ZONE_TIME_FORMAT, options).format(date),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Relative time
// ──────────────────────────────────────────────────────────────────────────

const TIME_UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: 'year', ms: 31_536_000_000 },
  { unit: 'month', ms: 2_628_000_000 },
  { unit: 'day', ms: 86_400_000 },
  { unit: 'hour', ms: 3_600_000 },
  { unit: 'minute', ms: 60_000 },
  { unit: 'second', ms: 1_000 },
];

export interface RelativeTimeOptions {
  /** The moment to measure from, in epoch milliseconds. Defaults to now. */
  now?: number;
  /** BCP 47 locale. Defaults to the runtime's locale. */
  locale?: string;
}

/**
 * Relative time in the largest whole unit, e.g. "3 days ago", "in 2 hours"
 * or "now" in `en-US`.
 */
export function formatRelativeTime(
  date: Date,
  { now = Date.now(), locale }: RelativeTimeOptions = {}
): string {
  const diff = date.getTime() - now;
  const abs = Math.abs(diff);
  for (const { unit, ms } of TIME_UNITS) {
    const value = Math.floor(abs / ms);
    if (value > 0) {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(
        diff < 0 ? -value : value,
        unit
      );
    }
  }
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    0,
    'second'
  );
}

/**
 * Relative time in up to three units, e.g. "2 hours, 15 minutes, 30 seconds
 * ago", "in 3 days, 0 hours, 5 minutes" or "Just now". This is the Geist
 * relative time card's label, and like it is English only: the platform has no
 * locale-aware multi-unit relative format.
 */
export function formatRelativeTimeDetailed(
  date: Date,
  { now = Date.now() }: Pick<RelativeTimeOptions, 'now'> = {}
): string {
  const diff = date.getTime() - now;
  let remaining = Math.abs(diff);
  const result: string[] = [];

  for (const { unit, ms } of TIME_UNITS) {
    const value = Math.floor(remaining / ms);
    if (value > 0 || result.length > 0) {
      result.push(`${value} ${unit}${value !== 1 ? 's' : ''}`);
      remaining %= ms;
    }
    if (result.length === 3) break;
  }

  if (result.length === 0) return 'Just now';
  const magnitude = result.join(', ');
  return diff > 0 ? `in ${magnitude}` : `${magnitude} ago`;
}
