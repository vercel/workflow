import { decodeTime } from 'ulid';
import { z } from 'zod';

const UlidSchema = z.string().ulid();

/**
 * Default threshold for ULID timestamps in the past (24 hours).
 *
 * Set to 24 hours to support the resilient start path: when start() fails to
 * create run_created, the queue carries the run input and the runtime creates
 * the run on run_started. VQS supports delayed messages up to 24 hours.
 */
export const DEFAULT_TIMESTAMP_THRESHOLD_PAST_MS = 24 * 60 * 60 * 1000;

/**
 * Default threshold for ULID timestamps in the future (5 minutes).
 *
 * Kept tight to prevent abuse from client-generated ULIDs with manipulated
 * future timestamps while still tolerating minor clock skew.
 */
export const DEFAULT_TIMESTAMP_THRESHOLD_FUTURE_MS = 5 * 60 * 1000;

/** @deprecated Use DEFAULT_TIMESTAMP_THRESHOLD_PAST_MS instead */
export const DEFAULT_TIMESTAMP_THRESHOLD_MS =
  DEFAULT_TIMESTAMP_THRESHOLD_PAST_MS;

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
 * Validates that a prefixed ULID's embedded timestamp is within acceptable thresholds
 * of the current server time. Uses asymmetric thresholds: 24h in the past (to support
 * resilient start with queue delays) and 5min in the future (to prevent abuse while
 * tolerating clock skew).
 *
 * @param prefixedUlid - The prefixed ULID to validate (e.g., "wrun_01ARYZ...")
 * @param prefix - The prefix to strip (e.g., "wrun_")
 * @param pastThresholdMs - Maximum allowed age in the past (default: 24 hours)
 * @param futureThresholdMs - Maximum allowed distance in the future (default: 5 minutes)
 * @returns null if valid, or an error message string if invalid
 */
export function validateUlidTimestamp(
  prefixedUlid: string,
  prefix: string,
  pastThresholdMs: number = DEFAULT_TIMESTAMP_THRESHOLD_PAST_MS,
  futureThresholdMs: number = DEFAULT_TIMESTAMP_THRESHOLD_FUTURE_MS
): string | null {
  const raw = prefixedUlid.startsWith(prefix)
    ? prefixedUlid.slice(prefix.length)
    : prefixedUlid;

  const ulidTimestamp = ulidToDate(raw);
  if (!ulidTimestamp) {
    return `Invalid runId: "${prefixedUlid}" is not a valid ULID`;
  }

  const serverTimestamp = new Date();
  const diffMs = serverTimestamp.getTime() - ulidTimestamp.getTime();

  // diffMs > 0 means the ULID is in the past; diffMs < 0 means it's in the future
  if (diffMs > 0 && diffMs <= pastThresholdMs) {
    return null; // Within past threshold
  }
  if (diffMs <= 0 && -diffMs <= futureThresholdMs) {
    return null; // Within future threshold
  }

  const driftMs = Math.abs(diffMs);
  const driftSeconds = Math.round(driftMs / 1000);
  const direction = diffMs > 0 ? 'past' : 'future';
  const thresholdMs = diffMs > 0 ? pastThresholdMs : futureThresholdMs;
  const thresholdSeconds = Math.round(thresholdMs / 1000);
  return `Invalid runId timestamp: embedded timestamp is ${driftSeconds}s in the ${direction} (threshold: ${thresholdSeconds}s)`;
}
