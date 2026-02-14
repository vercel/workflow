import { formatDuration } from '../../../lib/utils';

export { formatDuration };

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
 * Formats a duration for timeline display (compact single-unit format).
 * @deprecated Use formatDuration(ms, true) instead.
 */
export const formatDurationForTimeline = (ms: number): string =>
  formatDuration(ms, true);

const timeSelectionFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatTimeSelection(ms: number): string {
  if (ms >= 1000) {
    return `${timeSelectionFormatter.format(ms / 1000)}s`;
  }
  return `${timeSelectionFormatter.format(ms)}ms`;
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
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}
