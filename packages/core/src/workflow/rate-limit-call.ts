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
): {
  key: string;
  limit: number;
  periodMs: number;
  burst?: number;
  expiresAt: Date;
} {
  if (!options || typeof options !== 'object') {
    throw new TypeError(
      'experimental_rateLimit() expects an options object: { key, limit, period }'
    );
  }
  if (options.burst !== undefined && typeof options.burst !== 'boolean') {
    throw new TypeError(
      `experimental_rateLimit(): burst must be true or false, got ${JSON.stringify(options.burst)}`
    );
  }
  const call = {
    key: options.key,
    limit: options.limit,
    periodMs: durationMs(options.period, 'period'),
    // A full window. The wire takes a count, so a partial burst can come
    // later; a burst of 1 is no burst, so it isn't sent.
    ...(options.burst === true &&
      options.limit > 1 && { burst: options.limit }),
  };
  try {
    validateRateLimitCall(call);
  } catch (error) {
    throw new RangeError(
      `experimental_rateLimit(): ${(error as Error).message}`
    );
  }
  // Without a maxWait, or with a longer one, a call waits up to 30 days, the
  // most a World lets it.
  const waitMs =
    options.maxWait === undefined
      ? MAX_RATE_WAIT_MS
      : Math.min(durationMs(options.maxWait, 'maxWait'), MAX_RATE_WAIT_MS);
  return { ...call, expiresAt: new Date(nowMs + waitMs) };
}
