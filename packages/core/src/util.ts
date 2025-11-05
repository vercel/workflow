import type { StringValue } from 'ms';
import ms from 'ms';

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
 * Builds a workflow suspension log message based on the counts of steps, hooks, and waits.
 * @param runId - The workflow run ID
 * @param stepCount - Number of steps to be enqueued
 * @param hookCount - Number of hooks to be enqueued
 * @param waitCount - Number of waits to be enqueued
 * @returns The formatted log message or null if all counts are 0
 */
export function buildWorkflowSuspensionMessage(
  runId: string,
  stepCount: number,
  hookCount: number,
  waitCount: number
): string | null {
  if (stepCount === 0 && hookCount === 0 && waitCount === 0) {
    return null;
  }

  const parts = [];
  if (stepCount > 0) {
    parts.push(`${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`);
  }
  if (hookCount > 0) {
    parts.push(`${hookCount} ${hookCount === 1 ? 'hook' : 'hooks'}`);
  }
  if (waitCount > 0) {
    parts.push(`${waitCount} ${waitCount === 1 ? 'timer' : 'timers'}`);
  }

  const resumeMsgParts: string[] = [];
  if (stepCount > 0) {
    resumeMsgParts.push('steps are completed');
  }
  if (hookCount > 0) {
    resumeMsgParts.push('hooks are received');
  }
  if (waitCount > 0) {
    resumeMsgParts.push('timers have elapsed');
  }
  const resumeMsg = resumeMsgParts.join(' and ');

  return `[Workflows] "${runId}" - ${parts.join(' and ')} to be enqueued\n  Workflow will suspend and resume when ${resumeMsg}`;
}

/**
 * Generates a stream ID for a workflow run.
 * User-defined streams include a "user" segment for isolation from future system-defined streams.
 * Namespaces are base64-encoded to handle characters not allowed in Redis key names.
 *
 * @param runId - The workflow run ID
 * @param namespace - Optional namespace for the stream
 * @returns The stream ID in format: `strm_{ULID}_user_{base64(namespace)?}`
 */
export function getWorkflowRunStreamId(runId: string, namespace?: string) {
  const streamId = `${runId.replace('wrun_', 'strm_')}_user`;
  if (!namespace) {
    return streamId;
  }
  // Base64 encode the namespace to handle special characters that may not be allowed in Redis keys
  const encodedNamespace = Buffer.from(namespace, 'utf-8').toString(
    'base64url'
  );
  return `${streamId}_${encodedNamespace}`;
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
