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
 * The algorithm is GCRA. Each key stores `tat`, the next free slot. A call
 * whose interval is `T = periodMs / limit` and whose burst tolerance is `τ`
 * gets
 *
 *     acquireAt = max(now, tat - τ)        then        tat = max(tat, now) + T
 *
 * - **No burst** (the default, `τ = 0`): slots are exactly `T` apart and no
 *   period holds more than `limit` of them.
 * - **Burst** (`burst` on the call, `τ = (burst - 1) * T`, see
 *   {@link rateLimitToleranceUs}): the key is a token bucket holding `burst`
 *   calls, which may be more than `limit` (it saves up at most 24 hours of
 *   the rate). An idle key admits `burst` at once, then refills one per `T`.
 *   Any window of length `W` holds at most `floor((W + τ) / T) + 1` slots, so
 *   one rolling period can see up to `limit + burst - 1` calls.
 *
 * Each call uses its own `T` and `τ`, so calls on one key that ask for
 * different rates or bursts blend: each uses up its own share of the key's
 * time, and a bursting call can go ahead of non-bursting calls already
 * waiting. Use one setting per key. Times are microseconds so an interval
 * that isn't a whole millisecond (400/s is 2.5 ms) stays exact. The Vercel
 * World's backend makes the same decision.
 */

/** The longest key a call may use, in UTF-8 bytes. */
export const MAX_RATE_KEY_BYTES = 512;

/**
 * Keys that start with this are reserved for the Workflow SDK's own utilities
 * and libraries, like `$`-prefixed attribute keys. A call may use one only
 * with `allowReservedKey: true` ({@link assertRateLimitKeyAllowed}).
 */
export const RESERVED_RATE_LIMIT_KEY_PREFIX = '$';

/**
 * Throws a `RangeError` for a key in the reserved namespace
 * ({@link RESERVED_RATE_LIMIT_KEY_PREFIX}) unless the call opted in. Checked
 * on the call's `rate_created` request, by the runtime and by the World; a
 * call the World reserves again was already checked.
 */
export function assertRateLimitKeyAllowed(
  key: string,
  allowReservedKey: boolean | undefined
): void {
  if (
    allowReservedKey !== true &&
    typeof key === 'string' &&
    key.startsWith(RESERVED_RATE_LIMIT_KEY_PREFIX)
  ) {
    throw new RangeError(
      `rate limit key ${JSON.stringify(key.slice(0, 64))} starts with the reserved prefix "${RESERVED_RATE_LIMIT_KEY_PREFIX}": that namespace is reserved for Workflow SDK libraries. Set { allowReservedKey: true } only if your caller is one.`
    );
  }
}

/**
 * The longest period a call may use: 24 hours. With a call waiting at most
 * {@link MAX_RATE_WAIT_MS}, a daily limit already queues up to 30 times its
 * limit before calls fail. The Vercel World's backend uses the same bound.
 */
export const MAX_RATE_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * The shortest grace (see {@link rateGraceMs}): about how late a normal wake
 * through the queue arrives, with a cold start, the replay and a cross-region
 * write, at p99.
 */
export const RATE_GRACE_FLOOR_MS = 5_000;

/** The grace as a share of the period, between the floor and the max. */
export const RATE_GRACE_PERIOD_SHARE = 0.1;

/** The longest first grace, for long periods. */
export const RATE_GRACE_MAX_MS = 60_000;

/** How many times its first grace a call woken late again can get. */
export const RATE_GRACE_MAX_DOUBLING = 4;

/**
 * Late wakes after which the grace stops growing. A call at this count that
 * is late again is not counted further ({@link decideRateWake}).
 */
export const RATE_MAX_LATE_WAKES = Math.log2(RATE_GRACE_MAX_DOUBLING);

/**
 * How long after its slot a call may still go ahead. A `rate_acquired` later
 * than this (an orchestrator woken late by a queue delay or a cold start, or
 * every waiter resuming at once after an outage) does not go ahead on its old
 * slot: the World reserves the call again and commits what that decided in
 * place of the `rate_acquired`. A call goes ahead up to its grace late, so any
 * window of length `W` admits at most `floor((W + grace) / T) + 1` calls: over
 * one period, about `grace / period` more than the limit.
 *
 * So the grace is a share of the period ({@link RATE_GRACE_PERIOD_SHARE}),
 * never below {@link RATE_GRACE_FLOOR_MS} and never above
 * {@link RATE_GRACE_MAX_MS}. A call woken late again (`lateWakes`, recorded by
 * the World on the `rate_created` it reserves again) gets twice its last
 * grace, up to {@link RATE_GRACE_MAX_DOUBLING} times its first. The Vercel
 * World's backend uses the same grace.
 */
export function rateGraceMs(periodMs: number, lateWakes = 0): number {
  const first = Math.min(
    Math.max(RATE_GRACE_FLOOR_MS, periodMs * RATE_GRACE_PERIOD_SHARE),
    RATE_GRACE_MAX_MS
  );
  return Math.min(first * 2 ** lateWakes, first * RATE_GRACE_MAX_DOUBLING);
}

/**
 * How late a call at the largest grace may still go ahead on its recorded
 * slot: that grace plus one period. Any window then sees at most about
 * `largest grace / T + limit` calls that went ahead late, however long an
 * incident held them back.
 */
export function rateLateAdmitMaxMs(periodMs: number): number {
  return rateGraceMs(periodMs, RATE_MAX_LATE_WAKES) + periodMs;
}

/** What a World does with a `rate_acquired` (see {@link decideRateWake}). */
export type RateWakeDecision =
  | 'acquire'
  | 'acquire_late'
  | 'reserve_again'
  | 'fail';

/**
 * What a `rate_acquired` woken at `nowMs` for its recorded slot does:
 *
 * | Wake                                                     | Outcome         |
 * | -------------------------------------------------------- | --------------- |
 * | within its grace                                         | `acquire`       |
 * | past it, while its grace can still grow                  | `reserve_again` |
 * | past the largest grace, within {@link rateLateAdmitMaxMs} | `acquire_late`, or `fail` past the call's deadline |
 * | later than that                                          | `reserve_again` |
 *
 * `acquire_late` is for a call whose wake-to-write time (a cold start, a long
 * replay) is always longer than the largest grace: re-reserving it would loop
 * until its deadline. The ceiling keeps a sustained delivery incident, which
 * can bring every waiting call to the largest grace, from letting them all
 * through at once when it clears: those are reserved again, and drain at the
 * limit. A call reserved again records
 * `min(lateWakes + 1, RATE_MAX_LATE_WAKES)`. The Vercel World's backend makes
 * the same decision.
 */
export function decideRateWake(args: {
  acquireAt: Date;
  nowMs: number;
  periodMs: number;
  lateWakes: number;
  expiresAt: Date;
}): RateWakeDecision {
  const lateByMs = args.nowMs - args.acquireAt.getTime();
  if (lateByMs <= rateGraceMs(args.periodMs, args.lateWakes)) return 'acquire';
  if (
    args.lateWakes < RATE_MAX_LATE_WAKES ||
    lateByMs > rateLateAdmitMaxMs(args.periodMs)
  ) {
    return 'reserve_again';
  }
  return args.nowMs > args.expiresAt.getTime() ? 'fail' : 'acquire_late';
}

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
  /**
   * How many calls may go at once on an idle key, at least 1, saving up at
   * most 24 hours of the rate. Absent (or 1) for no burst.
   */
  burst?: number;
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
      `rate limit period of ${call.periodMs}ms is longer than the 24 hours allowed`
    );
  }
  if (
    call.burst !== undefined &&
    (!Number.isSafeInteger(call.burst) || call.burst < 1)
  ) {
    throw new RangeError(
      `rate limit burst must be a whole number of at least 1, got ${call.burst}`
    );
  }
  // A burst saves up `(burst - 1) * period / limit` of the key's time: at
  // most the longest period, so a bucket holds at most a day of the rate.
  if (
    call.burst !== undefined &&
    (call.burst - 1) * call.periodMs > MAX_RATE_PERIOD_MS * call.limit
  ) {
    throw new RangeError(
      `rate limit burst of ${call.burst} saves up more than 24 hours of a limit of ${call.limit} per ${call.periodMs}ms`
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

/**
 * A call's burst tolerance `(burst - 1) * T` in microseconds: what lets
 * `burst` calls go at once. 0 for no burst.
 *
 * `T` is rounded up to a whole microsecond, which could stretch it: a limit
 * of more than one call per microsecond would otherwise give a tolerance of
 * centuries. So it is never more than the exact `(burst - 1) * period /
 * limit`, rounded up, or the period, whichever is longer. Up to a burst of
 * `limit` that is the period, as a full window is less than one anyway.
 */
export function rateLimitToleranceUs(call: RateLimitCall): number {
  const burst = call.burst ?? 1;
  const exactUs = Math.ceil(((burst - 1) * call.periodMs * 1000) / call.limit);
  return Math.min(
    (burst - 1) * rateLimitIntervalUs(call),
    Math.max(call.periodMs * 1000, exactUs)
  );
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
  /** The call's burst tolerance (`rateLimitToleranceUs`). 0 if absent. */
  toleranceUs?: number;
  nowUs: number;
  deadlineUs: number;
}): RateLimitDecision {
  const { intervalUs, nowUs } = args;
  const toleranceUs = args.toleranceUs ?? 0;
  const acquireAtUs =
    args.tatUs === undefined
      ? nowUs
      : Math.max(nowUs, args.tatUs - toleranceUs);
  // A slot at `acquireAt` leaves `tat <= acquireAt + τ + T`.
  const deadlineUs = Math.min(
    args.deadlineUs,
    Number.MAX_SAFE_INTEGER - intervalUs - toleranceUs
  );
  if (acquireAtUs > deadlineUs) {
    return { status: 'deadline_exceeded', wouldAcquireAtUs: acquireAtUs };
  }
  return {
    status: 'reserved',
    acquireAtUs,
    tatUs: Math.max(args.tatUs ?? nowUs, nowUs) + intervalUs,
  };
}
