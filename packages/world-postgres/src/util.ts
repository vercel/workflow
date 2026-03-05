import { decodeTime } from 'ulid';
import { z } from 'zod';

const UlidSchema = z.string().ulid();

/**
 * Default threshold for ULID timestamp validation (5 minutes in milliseconds).
 */
export const DEFAULT_TIMESTAMP_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Validates that a prefixed ULID's embedded timestamp is within an acceptable threshold
 * of the current server time. This prevents client-generated ULIDs with manipulated timestamps.
 *
 * @param prefixedUlid - The prefixed ULID to validate (e.g., "wrun_01ARYZ...")
 * @param prefix - The prefix to strip (e.g., "wrun_")
 * @param thresholdMs - Maximum allowed drift in milliseconds (default: 5 minutes)
 * @returns null if valid, or an error message string if invalid
 */
export function validateUlidTimestamp(
  prefixedUlid: string,
  prefix: string,
  thresholdMs: number = DEFAULT_TIMESTAMP_THRESHOLD_MS
): string | null {
  const raw = prefixedUlid.startsWith(prefix)
    ? prefixedUlid.slice(prefix.length)
    : prefixedUlid;

  const parsed = UlidSchema.safeParse(raw);
  if (!parsed.success) {
    return `Invalid runId: "${prefixedUlid}" is not a valid ULID`;
  }

  const ulidTimestamp = new Date(decodeTime(parsed.data));
  const serverTimestamp = new Date();
  const driftMs = Math.abs(serverTimestamp.getTime() - ulidTimestamp.getTime());

  if (driftMs <= thresholdMs) {
    return null;
  }

  const driftSeconds = Math.round(driftMs / 1000);
  const thresholdSeconds = Math.round(thresholdMs / 1000);
  return `Invalid runId timestamp: embedded timestamp differs from server time by ${driftSeconds}s (threshold: ${thresholdSeconds}s)`;
}

export class Mutex {
  promise: Promise<unknown> = Promise.resolve();
  andThen<T>(fn: () => Promise<T> | T): Promise<T> {
    this.promise = this.promise.then(
      () => fn(),
      () => fn()
    );
    return this.promise as Promise<T>;
  }
}

export function compact<T extends object>(obj: T) {
  const value = {} as {
    [key in keyof T]: null extends T[key]
      ? undefined | NonNullable<T[key]>
      : T[key];
  };
  for (const key in obj) {
    if (obj[key] !== null) {
      value[key] = obj[key] as any;
    } else {
      value[key] = undefined as any;
    }
  }
  return value;
}
