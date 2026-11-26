/**
 * Time conversion utilities for workflow trace construction
 */

/**
 * Converts a Date to OpenTelemetry time format [seconds, nanoseconds]
 */
export function dateToOtelTime(
  date: Date | string | unknown
): [number, number] {
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

export function otelTimeToMs(time: [number, number]): number {
  const secondsToMs = time[0] * 1_000;
  const nanosecondsToMs = time[1] / 1_000_000;
  return secondsToMs + nanosecondsToMs;
}

/**
 * Calculates duration in [seconds, nanoseconds] format
 */
export function calculateDuration(
  start: Date | string | unknown,
  end: Date | string | unknown
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
