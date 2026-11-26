import type { Event } from '@workflow/world';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function parseDate(value: unknown): Date | null {
  if (value == null) return null;

  const date =
    value instanceof Date
      ? value
      : new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getEventDate(
  event: Pick<Event, 'createdAt' | 'occurredAt'>
): Date {
  return parseDate(event.occurredAt) ?? new Date(event.createdAt);
}

const timestampFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
});

const timestampFields = (date: Date) =>
  Object.fromEntries(
    timestampFormat.formatToParts(date).map(({ type, value }) => [type, value])
  );

export function formatTimestampParts(date: Date): {
  day: string;
  clock: string;
  ms: string;
} {
  const part = timestampFields(date);
  return {
    day: `${part.month} ${part.day}`,
    clock: `${part.hour}:${part.minute}:${part.second}`,
    ms: `.${part.fractionalSecond.slice(0, 2)}`,
  };
}

export function formatTimestamp(date: Date): string {
  const part = timestampFields(date);
  return `${part.month} ${Number(part.day)}, ${part.year} ${part.hour}:${part.minute}:${part.second}.${part.fractionalSecond}`;
}

export function formatShortUnit(ms: number): string {
  let value = ms / SECOND;
  let unit = 's';
  for (const [next, size] of [
    ['m', 60],
    ['h', 60],
    ['d', 24],
  ] as const) {
    if (Math.round(value) < size) break;
    value /= size;
    unit = next;
  }
  return `${Math.round(value)}${unit}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / SECOND));
  if (seconds >= 3600) return formatShortUnit(ms);
  const minutes = Math.floor(seconds / 60);
  return [minutes && `${minutes}m`, seconds % 60 && `${seconds % 60}s`]
    .filter(Boolean)
    .join(' ');
}

export function formatElapsed(ms: number): string {
  if (ms <= 0) return '0ms';
  if (ms < SECOND) return `+${Math.round(ms)}ms`;
  if (ms < 10 * SECOND) return `+${Number((ms / SECOND).toFixed(1))}s`;
  return `+${formatDuration(ms)}`;
}

const round2 = (value: number) => Number(value.toFixed(2));

export function formatPreciseDuration(ms: number): string {
  if (!round2(ms)) return '0';
  if (round2(ms) < SECOND) return `${round2(ms)}ms`;
  if (round2(ms / SECOND) < 60) return `${round2(ms / SECOND)}s`;
  return formatDuration(ms);
}

const TIME_UNITS = [
  ['year', 365 * DAY],
  ['month', 2_628_000_000],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
  ['second', SECOND],
] as const;

const relativeLabel = (diff: number, text: string): string =>
  diff < 0 ? `in ${text}` : `${text} ago`;

export function formatTimeAgo(date: number, now: number): string {
  const diff = now - date;
  let remaining = Math.abs(diff);
  const parts: string[] = [];

  for (const [unit, ms] of TIME_UNITS) {
    const value = Math.floor(remaining / ms);
    if (value > 0 || parts.length > 0) {
      parts.push(`${value} ${unit}${value !== 1 ? 's' : ''}`);
      remaining %= ms;
    }
    if (parts.length === 3) break;
  }

  return parts.length ? relativeLabel(diff, parts.join(', ')) : 'Just now';
}

export function formatShortTimeAgo(date: number, now: number): string {
  const diff = now - date;

  for (const [unit, ms] of [
    ['day', DAY],
    ['hour', HOUR],
    ['minute', MINUTE],
  ] as const) {
    const value = Math.floor(Math.abs(diff) / ms);
    if (value > 0) {
      return relativeLabel(diff, `${value} ${unit}${value > 1 ? 's' : ''}`);
    }
  }

  return 'Just now';
}

export function otelTimeToMs([seconds, nanoseconds]: [number, number]): number {
  return seconds * 1000 + nanoseconds / 1e6;
}

export function dateToOtelTime(date: unknown): [number, number] {
  if (typeof date === 'string') {
    date = new Date(date);
  }
  if (!date || !(date instanceof Date)) {
    return [0, 0];
  }
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = (ms % 1000) * 1_000_000;
  return [seconds, nanoseconds];
}

export function calculateDuration(
  start: unknown,
  end: unknown
): [number, number] {
  if (typeof start === 'string') {
    start = new Date(start);
  }
  if (typeof end === 'string') {
    end = new Date(end);
  }
  if (!start || !(start instanceof Date)) {
    return [0, 0];
  }
  const endTime = end && end instanceof Date ? end : new Date();
  const durationMs = endTime.getTime() - start.getTime();
  const seconds = Math.floor(durationMs / 1000);
  const nanoseconds = (durationMs % 1000) * 1_000_000;
  return [seconds, nanoseconds];
}
