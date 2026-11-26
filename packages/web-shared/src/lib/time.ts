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

const relativeTimeFormat = new Intl.RelativeTimeFormat('en-US', {
  numeric: 'auto',
});

const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
];

export function formatRelativeTime(date: number, now: number): string {
  const diff = date - now;
  const [unit, size] = RELATIVE_TIME_UNITS.find(
    ([, size]) => Math.abs(diff) >= size
  ) ?? ['second', SECOND];
  return relativeTimeFormat.format(Math.trunc(diff / size), unit);
}
