import { isRetryableWorldError } from '../classify-error.js';

const MAX_RETRIES = 10;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 300_000;

export function transientReadRetryDelayMs(
  error: unknown,
  attempt: number,
  intervalMs: number
): number | undefined {
  if (attempt >= MAX_RETRIES || !isRetryableWorldError(error)) return undefined;

  const backoffMs = Math.min(
    intervalMs * 2 ** attempt,
    Math.max(MAX_BACKOFF_MS, intervalMs)
  );
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  const retryAfterMs =
    typeof retryAfter === 'number' && Number.isFinite(retryAfter)
      ? retryAfter * 1_000
      : 0;
  return Math.max(backoffMs, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}
