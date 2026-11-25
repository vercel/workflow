import {
  assertRateLimitKeyAllowed,
  MAX_RATE_WAIT_MS,
  SPEC_VERSION_RATE_LIMITS,
  validateRateLimitCall,
} from '@workflow/world';
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
  allowReservedKey?: true;
} {
  if (!options || typeof options !== 'object') {
    throw new TypeError(
      'experimental_rateLimit() expects an options object: { key, limit, period }'
    );
  }
  if (
    options.burst !== undefined &&
    (typeof options.burst !== 'number' ||
      !Number.isSafeInteger(options.burst) ||
      options.burst < 1)
  ) {
    throw new RangeError(
      `experimental_rateLimit(): burst must be a whole number of at least 1, got ${JSON.stringify(options.burst)}`
    );
  }
  const call = {
    key: options.key,
    limit: options.limit,
    periodMs: durationMs(options.period, 'period'),
    // A burst of 1 is no burst, so it isn't sent. One that saves up more
    // than a day is refused by `validateRateLimitCall`.
    ...(options.burst !== undefined &&
      options.burst > 1 && { burst: options.burst }),
  };
  if (
    options.allowReservedKey !== undefined &&
    typeof options.allowReservedKey !== 'boolean'
  ) {
    throw new TypeError(
      `experimental_rateLimit(): allowReservedKey must be true or false, got ${JSON.stringify(options.allowReservedKey)}`
    );
  }
  try {
    validateRateLimitCall(call);
    assertRateLimitKeyAllowed(call.key, options.allowReservedKey);
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
  return {
    ...call,
    expiresAt: new Date(nowMs + waitMs),
    // Sent, so the World checks the key the same way.
    ...(options.allowReservedKey === true && { allowReservedKey: true }),
  };
}

/** Why a run below spec 10 can't call `experimental_rateLimit()`. */
export function rateLimitSpecVersionMessage(
  runSpecVersion: number | undefined
): string {
  return (
    `experimental_rateLimit() needs a run at spec version ${SPEC_VERSION_RATE_LIMITS} or later, ` +
    `and this run is at ${runSpecVersion ?? 'an unknown version'}. ` +
    `A World that supports rate limits creates spec ${SPEC_VERSION_RATE_LIMITS} runs by default, unless WORKFLOW_SPEC_VERSION selects an earlier version.`
  );
}
