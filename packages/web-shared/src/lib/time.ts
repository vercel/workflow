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
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 2,
  hourCycle: 'h23',
});

export function formatTimestampParts(date: Date): {
  day: string;
  clock: string;
  ms: string;
} {
  const part = Object.fromEntries(
    timestampFormat.formatToParts(date).map(({ type, value }) => [type, value])
  );
  return {
    day: `${part.month} ${part.day}`,
    clock: `${part.hour}:${part.minute}:${part.second}`,
    ms: `.${part.fractionalSecond}`,
  };
}

export function formatTimestamp(date: Date): string {
  const { day, clock, ms } = formatTimestampParts(date);
  return `${day} ${clock}${ms}`;
}

export function formatDuration(ms: number, fractionDigits?: number): string {
  if (Math.round(ms) < SECOND) return `${Math.round(ms)}ms`;

  const digits = fractionDigits ?? (Math.round(ms / 10) * 10 < MINUTE ? 2 : 0);
  const step = SECOND / 10 ** digits;
  const rounded = Math.round(ms / step) * step;
  const seconds = Number(((rounded % MINUTE) / SECOND).toFixed(digits));

  return [
    [Math.floor(rounded / DAY), 'd'],
    [Math.floor((rounded % DAY) / HOUR), 'h'],
    [Math.floor((rounded % HOUR) / MINUTE), 'm'],
    [seconds, 's'],
  ]
    .filter(([value]) => value)
    .map(([value, unit]) => `${value}${unit}`)
    .join(' ');
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
