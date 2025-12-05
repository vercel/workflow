export function getHighResInMs([seconds, nanoseconds]: [
  number,
  number,
]): number {
  return seconds * 1000 + nanoseconds / 1e6;
}

export function getMsInHighRes(ms: number): [number, number] {
  return [Math.floor(ms / 1000), (ms % 1000) * 1000];
}

const durationFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

const MS_IN_SECOND = 1000;
const MS_IN_MINUTE = 60 * MS_IN_SECOND;
const MS_IN_HOUR = 60 * MS_IN_MINUTE;
const MS_IN_DAY = 24 * MS_IN_HOUR;

/**
 * Formats a duration in the most accurate single-part string.
 * - For durations < 1s: shows milliseconds (e.g., "500ms")
 * - For durations < 1m: shows seconds (e.g., "45s")
 * - For durations < 1h: shows minutes (e.g., "45m")
 * - For durations < 1d: shows hours (e.g., "45h")
 * Largest time is hours.
 */
export const formatDurationForTimeline = (ms: number): string => {
  if (ms < MS_IN_SECOND) {
    return `${durationFormatter.format(ms)}ms`;
  }
  if (ms < MS_IN_MINUTE) {
    return `${durationFormatter.format(ms / MS_IN_SECOND)}s`;
  }
  if (ms < MS_IN_HOUR) {
    return `${durationFormatter.format(ms / MS_IN_MINUTE)}m`;
  }
  // For durations >= 1 hour (including >= 1 day), show hours
  return `${durationFormatter.format(ms / MS_IN_HOUR)}h`;
};

/**
 * Formats a duration in milliseconds to a human-readable string.
 * - For durations < 1s: shows milliseconds (e.g., "500ms")
 * - For durations < 1m: shows seconds (e.g., "45.5s")
 * - For durations >= 1m: shows human-readable format (e.g., "1h 30m", "2d 5h")
 */
export function formatDuration(ms: number): string {
  if (ms === 0) {
    return '0';
  }

  // For durations less than 1 second, show milliseconds
  if (ms < MS_IN_SECOND) {
    return `${durationFormatter.format(ms)}ms`;
  }

  // For durations less than 1 minute, show seconds
  if (ms < MS_IN_MINUTE) {
    return `${durationFormatter.format(ms / MS_IN_SECOND)}s`;
  }

  // For durations >= 1 minute, show human-readable format
  const days = Math.floor(ms / MS_IN_DAY);
  const hours = Math.floor((ms % MS_IN_DAY) / MS_IN_HOUR);
  const minutes = Math.floor((ms % MS_IN_HOUR) / MS_IN_MINUTE);
  const seconds = Math.floor((ms % MS_IN_MINUTE) / MS_IN_SECOND);

  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (hours <= 1 && (seconds > 0 || parts.length === 0)) {
    parts.push(`${seconds}s`);
  }

  return parts.join(' ');
}

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
