import type { StringValue } from 'ms';
import { throwNotInWorkflowContext } from './context-errors.js';
import { WORKFLOW_RATE_LIMIT } from './symbols.js';

/** One `experimental_rateLimit()` call. */
export interface RateLimitOptions {
  /**
   * What is limited. Every call with the same key shares its rate, across
   * every run of the project and environment. At most 512 bytes. Keys are
   * stored as-is in the run's events, so don't put personal data in them.
   */
  key: string;
  /** How many calls the key admits per `period`. */
  limit: number;
  /**
   * The period `limit` applies to: a duration string like `"1s"`, `"1m"` or
   * `"1h"`, or milliseconds. At most 365 days.
   */
  period: StringValue | number;
  /**
   * The longest the call waits for its slot. When the key's next slot is
   * later than that, the call rejects with `RateLimitTimeoutError` at once
   * and uses up none of the key's capacity. Without one, the call waits up
   * to 30 days, which is also the longest a timeout can be.
   */
  timeout?: StringValue | number;
}

/**
 * Wait for a slot under a shared rate limit, inside a workflow.
 *
 * Calls with the same `key` share its rate across every run of the project:
 * at most `limit` calls go ahead per `period`, each at least `period / limit`
 * after the one before. A call whose slot is now resolves at once; otherwise
 * the run sleeps until its slot, like `sleep()`, and resolves then. When the
 * slot would be later than `timeout`, the call rejects with
 * `RateLimitTimeoutError` instead, without using up a slot.
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
