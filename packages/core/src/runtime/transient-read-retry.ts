import { isRetryableWorldError } from '../classify-error.js';

/** Consecutive transient read failures `run.returnValue` retries. */
export const TRANSIENT_READ_MAX_RETRIES = 10;
/** Upper bound on the exponential backoff, unless the poll interval is longer. */
export const TRANSIENT_READ_MAX_BACKOFF_MS = 30_000;
/** Upper bound on how long a `retryAfter` from the World is honored. */
export const TRANSIENT_READ_MAX_RETRY_AFTER_MS = 300_000;

/**
 * How long `run.returnValue` waits before re-reading the run after a failed
 * read, or `undefined` when the error must reach the caller.
 *
 * Only transient World errors are retried (see `isRetryableWorldError`): a
 * `ThrottleError`, a 5xx, or a transport failure such as a timeout. The delay
 * starts at the poll interval and doubles with each consecutive failure, up
 * to {@link TRANSIENT_READ_MAX_BACKOFF_MS} (or the interval itself, when that
 * is longer). A `retryAfter` on the error raises the delay, never lowers it,
 * and is capped at {@link TRANSIENT_READ_MAX_RETRY_AFTER_MS}. After
 * {@link TRANSIENT_READ_MAX_RETRIES} failures in a row the error is returned
 * to the caller.
 *
 * A World client can retry a request itself before the error reaches here
 * (`world-vercel` retries a 5xx in-process), so one retry here can stand for
 * several requests; the backoff keeps that to a handful of reads a minute.
 * A firewall challenge (a 429 that `world-vercel` reports as a `TRANSPORT`
 * error) lasts for the incident, and that client does not retry it in-process
 * so as not to hammer the firewall. It is retried here on the same backoff,
 * and bounded by the same limit, because outside workflow code no queue
 * delivery retries the read later: giving up at once would end the caller's
 * await on the first challenge.
 *
 * @param attempt Transient failures since the last successful read.
 * @param intervalMs `WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS`.
 */
export function transientReadRetryDelayMs(
  error: unknown,
  attempt: number,
  intervalMs: number
): number | undefined {
  if (attempt >= TRANSIENT_READ_MAX_RETRIES || !isRetryableWorldError(error)) {
    return undefined;
  }

  const backoffMs = Math.min(
    intervalMs * 2 ** attempt,
    Math.max(TRANSIENT_READ_MAX_BACKOFF_MS, intervalMs)
  );
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  const retryAfterMs =
    typeof retryAfter === 'number' && Number.isFinite(retryAfter)
      ? retryAfter * 1_000
      : 0;
  return Math.max(
    backoffMs,
    Math.min(retryAfterMs, TRANSIENT_READ_MAX_RETRY_AFTER_MS)
  );
}
