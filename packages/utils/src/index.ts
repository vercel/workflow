import type { StringValue } from 'ms';
import ms from 'ms';
import { pidToPorts } from 'pid-port';

export interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
}

/**
 * Polyfill for `Promise.withResolvers()`.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
 */
export function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

/**
 * Creates a lazily-evaluated, memoized version of the provided function.
 *
 * The returned object exposes a `value` getter that calls `fn` only once,
 * caches its result, and returns the cached value on subsequent accesses.
 *
 * @typeParam T - The return type of the provided function.
 * @param fn - The function to be called once and whose result will be cached.
 * @returns An object with a `value` property that returns the memoized result of `fn`.
 */
export function once<T>(fn: () => T) {
  const result = {
    get value() {
      const value = fn();
      Object.defineProperty(result, 'value', { value });
      return value;
    },
  };
  return result;
}

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
 * @throws {Error} If the parameter is invalid or cannot be parsed
 */
export function parseDurationToDate(param: StringValue | Date | number): Date {
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

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 */
export async function getPort(): Promise<number | undefined> {
  const pid = process.pid;
  const ports = await pidToPorts(pid);
  if (!ports || ports.size === 0) {
    return undefined;
  }

  const smallest = Math.min(...ports);
  return smallest;
}
