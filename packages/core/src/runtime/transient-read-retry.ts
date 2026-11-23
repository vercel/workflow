import { isRetryableWorldError } from '../classify-error.js';

const MAX_BACKOFF_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export function transientReadRetryDelayMs(
  error: unknown,
  attempt: number,
  intervalMs: number
): number | undefined {
  if (!isRetryableWorldError(error)) return undefined;

  const backoffMs = Math.min(
    intervalMs * 2 ** attempt,
    Math.max(MAX_BACKOFF_MS, intervalMs)
  );
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  const retryAfterMs =
    typeof retryAfter === 'number' && Number.isFinite(retryAfter)
      ? retryAfter * 1_000
      : 0;
  // setTimeout overflows past 2^31 - 1 ms and fires at once
  return Math.min(Math.max(backoffMs, retryAfterMs), MAX_TIMER_MS);
}
