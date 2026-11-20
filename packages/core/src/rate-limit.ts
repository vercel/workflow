import type { StringValue } from 'ms';
import { throwNotInWorkflowContext } from './context-errors.js';
import { WORKFLOW_RATE_LIMIT } from './symbols.js';

/** One `experimental_rateLimit()` call. */
export interface RateLimitOptions {
  /**
   * What is limited. Every call with the same key shares its rate, across
   * every run of the project and environment. From 1 character to 512 bytes
   * (UTF-8). Keys that start with `$` are reserved for Workflow SDK libraries
   * and are refused unless `allowReservedKey` is set. Keys are stored as-is
   * in the run's events, so don't put personal data in them.
   */
  key: string;
  /**
   * How many calls the key admits per `period`. Use the same `limit`,
   * `period` and `burst` wherever a key is used: each call applies its own,
   * so a call with a longer interval holds up every call after it on the key,
   * and a changed limit applies after the slots already reserved.
   */
  limit: number;
  /**
   * The period `limit` applies to: a duration string like `"1s"`, `"1m"` or
   * `"1h"`, or milliseconds. At most 24 hours.
   */
  period: StringValue | number;
  /**
   * The longest the call waits for its slot. When the key's next slot is
   * later than that, the call rejects with `RateLimitMaxWaitError` at once
   * and uses up none of the key's capacity. Without one, the call waits up
   * to 30 days, which is also the longest `maxWait` can be.
   */
  maxWait?: StringValue | number;
  /**
   * How many calls may go ahead at once on an idle key: 1 (the default) is
   * no burst, and it may be more than `limit`, saving up at most 24 hours of
   * the rate (`limit: 1, period: "1s", burst: 60` saves up a minute). The
   * key then refills one call every
   * `period / limit`, like a token bucket of size `burst`: the long-run rate
   * is still `limit` per `period`, but a rolling `period` can see up to
   * `limit + burst - 1` calls. Match an upstream that publishes a burst size,
   * or pick the largest burst that keeps `limit + burst - 1` under the
   * upstream's cap per window. Use one setting per key: a bursting call can
   * go ahead of calls already waiting with a smaller burst.
   */
  burst?: number;
  /**
   * Allow a `key` that starts with `$`.
   *
   * **Do not set this in application code.** The `$` namespace is reserved
   * for Workflow SDK utilities and libraries, which rely on owning those keys
   * (and the shared capacity behind them). A workflow that writes a reserved
   * key can starve those libraries' calls, or be starved by them, and may
   * break when a future SDK release starts using that key. Without this
   * option, a `$` key throws a `RangeError` before anything is recorded.
   */
  allowReservedKey?: boolean;
}

/**
 * Wait for a slot under a shared rate limit, inside a workflow.
 *
 * Calls with the same `key` share its rate across every run of the project:
 * they get slots at most `limit` per `period`, each at least `period / limit`
 * after the one before. A call whose run wakes late can still go ahead within
 * a grace of its slot (at least 5 seconds), so keep handling the upstream's
 * own rate limit errors. A call whose slot is now resolves at once; otherwise
 * the run sleeps until its slot, like `sleep()`, and resolves then. When the
 * slot would be later than `maxWait`, the call rejects with
 * `RateLimitMaxWaitError` instead, without using up a slot.
 *
 * Experimental: needs runs created at spec version 10
 * (`WORKFLOW_SPEC_VERSION=10`) on a World that supports rate limits.
 *
 * @example
 * ```ts
 * export async function summarize(docs: string[]) {
 *   'use workflow';
 *   for (const doc of docs) {
 *     await experimental_rateLimit({ key: 'openai', limit: 60, period: '1m' });
 *     await callModel(doc);
 *   }
 * }
 * ```
 */
export async function experimental_rateLimit(
  options: RateLimitOptions
): Promise<void> {
  // Inside the workflow VM the implementation is stored on globalThis behind
  // a symbol, like `sleep()`'s.
  const rateLimitFn = (globalThis as any)[WORKFLOW_RATE_LIMIT];
  if (!rateLimitFn) {
    throwNotInWorkflowContext(
      'experimental_rateLimit()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/rate-limit',
      experimental_rateLimit
    );
  }
  return rateLimitFn(options);
}
