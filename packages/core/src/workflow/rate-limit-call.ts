import { MAX_RATE_WAIT_MS, validateRateLimitCall } from '@workflow/world';
import ms, { type StringValue } from 'ms';
import type { RateLimitOptions } from '../rate-limit.js';

function durationMs(value: StringValue | number, name: string): number {
  const parsed = typeof value === 'number' ? value : ms(value);
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
    throw new RangeError(
      `experimental_rateLimit(): invalid ${name} ${JSON.stringify(value)}. Expected a duration like "1s", "1m" or "1h", or milliseconds.`
    );
  }
  return parsed;
}

/**
 * The call as its `rate_created` carries it, checked the way the World checks
 * it. `nowMs` is the workflow's deterministic clock.
 *
 */
export function resolveRateLimitCall(
  options: RateLimitOptions,
  nowMs: number
): { key: string; limit: number; periodMs: number; expiresAt: Date } {
  if (!options || typeof options !== 'object') {
    throw new TypeError(
      'experimental_rateLimit() expects an options object: { key, limit, period }'
    );
  }
  const call = {
    key: options.key,
    limit: options.limit,
    periodMs: durationMs(options.period, 'period'),
  };
  try {
    validateRateLimitCall(call);
  } catch (error) {
    throw new RangeError(
      `experimental_rateLimit(): ${(error as Error).message}`
    );
  }
  // Without a timeout, or with a longer one, a call waits up to 30 days, the
  // most a World lets it.
  const waitMs =
    options.timeout === undefined
      ? MAX_RATE_WAIT_MS
      : Math.min(durationMs(options.timeout, 'timeout'), MAX_RATE_WAIT_MS);
  return { ...call, expiresAt: new Date(nowMs + waitMs) };
}
