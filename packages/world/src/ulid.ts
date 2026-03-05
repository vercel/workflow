import { decodeTime } from 'ulid';
import { z } from 'zod';

const UlidSchema = z.string().ulid();

/**
 * Default threshold for ULID timestamp validation (5 minutes in milliseconds).
 */
export const DEFAULT_TIMESTAMP_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Extracts a Date from a ULID string, or null if the string is not a valid ULID.
 */
export function ulidToDate(maybeUlid: string): Date | null {
  const ulid = UlidSchema.safeParse(maybeUlid);
  if (!ulid.success) {
    return null;
  }

  return new Date(decodeTime(ulid.data));
}

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

  const ulidTimestamp = ulidToDate(raw);
  if (!ulidTimestamp) {
    return `Invalid runId: "${prefixedUlid}" is not a valid ULID`;
  }

  const serverTimestamp = new Date();
  const driftMs = Math.abs(serverTimestamp.getTime() - ulidTimestamp.getTime());

  if (driftMs <= thresholdMs) {
    return null;
  }

  const driftSeconds = Math.round(driftMs / 1000);
  const thresholdSeconds = Math.round(thresholdMs / 1000);
  return `Invalid runId timestamp: embedded timestamp differs from server time by ${driftSeconds}s (threshold: ${thresholdSeconds}s)`;
}
