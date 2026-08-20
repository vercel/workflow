import { formatDuration, formatDurationPrecise } from '../../../lib/utils';

export { formatDuration, formatDurationPrecise };

export function getHighResInMs([seconds, nanoseconds]: [
  number,
  number,
]): number {
  return seconds * 1000 + nanoseconds / 1e6;
}

export function getMsInHighRes(ms: number): [number, number] {
  return [Math.floor(ms / 1000), (ms % 1000) * 1000];
}

/**
 * Formats a duration for timeline display (compact format).
 * @deprecated Use formatDuration(ms, true) instead.
 */
export const formatDurationForTimeline = (ms: number): string =>
  formatDuration(ms, true);

export function formatTimeSelection(ms: number): string {
  const roundedMs = Math.round(ms);
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Format an epoch-millisecond timestamp as a local wall-clock time.
 * Returns a compact HH:MM:SS.mmm string (24-hour format).
 */
export function formatWallClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

const UTC_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * Format an epoch-millisecond timestamp as a UTC date and 12-hour clock time
 * (e.g. "August 20, 2026 09:31:38 AM"). Independent of the process timezone.
 */
export function formatUtcDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  const month = UTC_MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const minute = String(d.getUTCMinutes()).padStart(2, '0');
  const second = String(d.getUTCSeconds()).padStart(2, '0');
  const hour24 = d.getUTCHours();
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const hour = String(hour12).padStart(2, '0');
  return `${month} ${day}, ${year} ${hour}:${minute}:${second} ${period}`;
}
