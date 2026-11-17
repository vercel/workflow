import { validateRateLimitCall } from '@workflow/world';
import ms, { type StringValue } from 'ms';
import type { RateLimitOptions } from '../rate-limit.js';

/** How long a call without a `timeout` may wait for its slot. */
const UNTIMED_CALL_MAX_WAIT_MS = 365 * 24 * 60 * 60 * 1000;

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
  const waitMs =
    options.timeout === undefined
      ? UNTIMED_CALL_MAX_WAIT_MS
      : durationMs(options.timeout, 'timeout');
  return { ...call, expiresAt: new Date(nowMs + waitMs) };
}
