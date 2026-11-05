import type { StringValue } from 'ms';
import ms from 'ms';

/**
 * Parses a duration parameter (string, number, or Date) and returns a Date object
 * representing when the duration should elapse.
 *
 * - For strings: Parses duration strings like "1s", "5m", "1h", etc. using the `ms` library
 * - For numbers: Treats as milliseconds from now
 * - For Date objects: Returns the date directly (handles both Date instances and date-like objects from deserialization)
 *
 * @param param - The duration parameter (StringValue, Date, or number of milliseconds)
 * @returns A Date object representing when the duration should elapse
 * @throws {Error} If the parameter is invalid or cannot be parsed, or the
 *   resulting time is not a valid date (an Invalid Date, or a duration that
 *   lands past the largest time a Date can hold)
 */
export function parseDurationToDate(param: StringValue | Date | number): Date {
  const date = durationToDate(param);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      typeof param === 'object'
        ? 'Invalid date: the Date object does not hold a valid time.'
        : `Invalid duration: ${JSON.stringify(param)} ends past the latest time a Date can represent.`
    );
  }
  return date;
}

function durationToDate(param: StringValue | Date | number): Date {
  if (typeof param === 'string') {
    const durationMs = ms(param);
    if (typeof durationMs !== 'number' || durationMs < 0) {
      throw new Error(
        `Invalid duration: "${param}". Expected a valid duration string like "1s", "1m", "1h", etc.`
      );
    }
    return new Date(Date.now() + durationMs);
  } else if (typeof param === 'number') {
    if (param < 0 || !Number.isFinite(param)) {
      throw new Error(
        `Invalid duration: ${param}. Expected a non-negative finite number of milliseconds.`
      );
    }
    return new Date(Date.now() + param);
  } else if (
    param instanceof Date ||
    (param &&
      typeof param === 'object' &&
      typeof (param as any).getTime === 'function')
  ) {
    // Handle both Date instances and date-like objects (from deserialization)
    return param instanceof Date ? param : new Date((param as any).getTime());
  } else {
    throw new Error(
      `Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.`
    );
  }
}
