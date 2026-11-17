/**
 * `experimental_rateLimit()`: what a call may ask for, and the decision a
 * World makes for it.
 *
 * A World that declares `WorldCapabilities.rateLimits` reserves each call's
 * slot when its `rate_created` is written, and commits what the reservation
 * decided in place of the request (see the rate events in `events.ts`). The
 * Vercel World's backend does this on its own store; this module is the same
 * algorithm for Worlds that keep their own state, such as `world-local`.
 *
 * The algorithm is GCRA with no burst tolerance. Each key stores `tat`, the
 * next free slot. A call whose interval is `T = periodMs / limit` gets
 *
 *     acquireAt = max(now, tat)        then        tat = acquireAt + T
 *
 * so slots are exactly `T` apart and no period holds more than `limit` of
 * them. Each call uses its own `T`, so calls on one key that ask for
 * different rates blend: each uses up its own share of the key's time. Times
 * are microseconds so an interval that isn't a whole millisecond (400/s is
 * 2.5 ms) stays exact.
 */

/** The longest key a call may use, in UTF-8 bytes. */
export const MAX_RATE_KEY_BYTES = 512;

/** The longest period a call may use: 365 days. */
export const MAX_RATE_PERIOD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * How long after its slot a call may still go ahead. A `rate_acquired` later
 * than this (an orchestrator woken late by a queue delay or a cold start, or
 * every waiter resuming at once after an outage) does not go ahead on its old
 * slot: the World reserves the call again and commits what that decided in
 * place of the `rate_acquired`. Calls go ahead at least `T - grace` apart, so
 * a period can admit up to `limit + ceil(grace / T)` of them. The Vercel
 * World's backend uses the same window.
 */
export const RATE_ACQUIRE_GRACE_MS = 5_000;

/**
 * The longest a call may wait for its slot: a later deadline is capped to 30
 * days after the World decides the call, and the committed event records the
 * capped one. The Vercel World's backend uses the same cap.
 */
export const MAX_RATE_WAIT_MS = 30 * 24 * 60 * 60 * 1000;

/** What a call asks for, as its `rate_created` carries it. */
export interface RateLimitCall {
  key: string;
  limit: number;
  periodMs: number;
}

/**
 * Check a call's key, limit and period, the same way the Vercel World's
 * backend does. Throws a `RangeError` naming the first bad field.
 */
export function validateRateLimitCall(call: RateLimitCall): void {
  if (typeof call.key !== 'string' || call.key.length === 0) {
    throw new RangeError('rate limit key must be a non-empty string');
  }
  const keyBytes = new TextEncoder().encode(call.key).byteLength;
  if (keyBytes > MAX_RATE_KEY_BYTES) {
    throw new RangeError(
      `rate limit key is ${keyBytes} bytes, more than the ${MAX_RATE_KEY_BYTES} allowed`
    );
  }
  if (!Number.isSafeInteger(call.limit) || call.limit < 1) {
    throw new RangeError(
      `rate limit must be a positive integer, got ${call.limit}`
    );
  }
  if (!Number.isSafeInteger(call.periodMs) || call.periodMs < 1) {
    throw new RangeError(
      `rate limit period must be a positive whole number of milliseconds, got ${call.periodMs}`
    );
  }
  if (call.periodMs > MAX_RATE_PERIOD_MS) {
    throw new RangeError(
      `rate limit period of ${call.periodMs}ms is longer than the 365 days allowed`
    );
  }
}

/**
 * A call's interval `periodMs / limit` in microseconds, rounded up so
 * rounding never lets more than `limit` through in a period, and never 0.
 */
export function rateLimitIntervalUs(call: RateLimitCall): number {
  return Math.max(1, Math.ceil((call.periodMs * 1000) / call.limit));
}

export type RateLimitDecision =
  | {
      status: 'reserved';
      /** The call's slot. At or before `nowUs`, it goes ahead at once. */
      acquireAtUs: number;
      /** The key's next free slot, to store. */
      tatUs: number;
    }
  | {
      status: 'deadline_exceeded';
      /** The slot the call would have had. Nothing is reserved. */
      wouldAcquireAtUs: number;
    };

/**
 * Decide one reservation from the key's stored `tat` (undefined for a key
 * with none). Pure: the World stores `tatUs` atomically with the decision.
 *
 * The deadline is narrowed so `tat` never passes `Number.MAX_SAFE_INTEGER`:
 * a far-future deadline, such as an untimed call's, is accepted rather than
 * refused.
 */
export function decideRateLimit(args: {
  tatUs: number | undefined;
  intervalUs: number;
  nowUs: number;
  deadlineUs: number;
}): RateLimitDecision {
  const { intervalUs, nowUs } = args;
  const acquireAtUs = Math.max(nowUs, args.tatUs ?? nowUs);
  const deadlineUs = Math.min(
    args.deadlineUs,
    Number.MAX_SAFE_INTEGER - intervalUs
  );
  if (acquireAtUs > deadlineUs) {
    return { status: 'deadline_exceeded', wouldAcquireAtUs: acquireAtUs };
  }
  return { status: 'reserved', acquireAtUs, tatUs: acquireAtUs + intervalUs };
}
