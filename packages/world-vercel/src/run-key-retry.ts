/**
 * Bounded in-process retry for HTTP 429 from the Vercel API's run-key endpoint
 * (`GET /v1/workflow/run-key/:deploymentId`, see `fetchRunKey`).
 *
 * The shared RetryAgent deliberately does not retry 429 (see
 * RETRY_AGENT_OPTIONS in http-client.ts): the Vercel firewall issues its
 * challenges as 429s, and retrying those in-process only hammers a firewall
 * that is already shedding load. That reasoning does not hold for the run-key
 * endpoint's own rate limit, and nothing above `fetchRunKey` retries a failed
 * key fetch either: `resumeHook()` fetches a cross-deployment run's key, so a
 * single 429 there throws the whole resume away.
 *
 * The endpoint is rate limited per owner over a 60s window. A burst larger
 * than the limit gets its first requests through and a 429 for the rest. Each
 * 429 carries `Retry-After` and `X-RateLimit-Reset`, and both point one whole
 * window after the rejection, not at the moment capacity next frees up.
 *
 * The policy, for one `fetchRunKey` call:
 *
 * - Only a 429 from the API itself is retried. A 429 carrying
 *   `x-vercel-mitigated` (a firewall `challenge`, or a firewall rule's `deny`)
 *   surfaces immediately, as it does everywhere else in this package.
 * - Never earlier than the server asked: the wait is `Retry-After` (seconds or
 *   an HTTP date), else `X-RateLimit-Reset`, else an exponential backoff from
 *   RUN_KEY_RETRY_FALLBACK_BACKOFF_MS.
 * - Plus up to RUN_KEY_RETRY_JITTER_RATIO of that wait in random jitter, so a
 *   herd rejected together does not come back together on the same second
 *   and spend the next window's capacity in one burst.
 * - At most RUN_KEY_RETRY_MAX_ATTEMPTS attempts and RUN_KEY_RETRY_BUDGET_MS of
 *   cumulative waiting, and never a wait that would run into the function's
 *   deadline. A wait that does not fit is not taken at all: the 429 surfaces
 *   at once rather than after a sleep that could only end in the same 429.
 *
 * Against today's 60s `Retry-After` that comes to one retry, 60-75s after the
 * first attempt. A second would wait at least another 60s, past the budget.
 */

import { resolveDeadlineMs, sleep } from './event-retry.js';
import { parseRetryAfter } from './http-core.js';

/** Attempts per `fetchRunKey` call, including the first. */
export const RUN_KEY_RETRY_MAX_ATTEMPTS = 4;

/**
 * Cumulative wait across one call's retries. Covers one full 60s window plus
 * its jitter (75s at most), so a burst up to roughly twice the per-window
 * limit is absorbed, while a caller that is a request handler is never held
 * for a second window. A burst larger than that is one no in-process wait can
 * drain; it needs a higher limit or a caller-level retry.
 */
export const RUN_KEY_RETRY_BUDGET_MS = 90_000;

/**
 * Time a wait leaves before the function's deadline, for the retried request
 * and the work its caller does with the key (for `resumeHook()`, the
 * `hook_received` write).
 */
export const RUN_KEY_RETRY_DEADLINE_RESERVE_MS = 10_000;

/** Wait before the first retry when a 429 names no wait; doubles per retry. */
export const RUN_KEY_RETRY_FALLBACK_BACKOFF_MS = 5_000;

/** Largest jitter, as a fraction of the wait the server asked for. */
export const RUN_KEY_RETRY_JITTER_RATIO = 0.25;

/** Floor on the jitter range, so `Retry-After: 0` still spreads a herd. */
export const RUN_KEY_RETRY_MIN_JITTER_MS = 1_000;

/**
 * `X-RateLimit-Reset` values at or above this read as an absolute epoch
 * timestamp in seconds, which is what the Vercel API sends; anything smaller
 * as a delay in seconds, which is what later IETF drafts specify.
 */
const EPOCH_SECONDS_THRESHOLD = 1e9;

/** A 429 that the run-key rate limiter itself returned. */
export interface RunKeyRateLimit {
  /**
   * How long the server asked the client to wait, in milliseconds, from
   * `Retry-After` or else `X-RateLimit-Reset`. `undefined` when it sent
   * neither.
   */
  retryAfterMs: number | undefined;
}

function parseRateLimitReset(
  value: string | null,
  now: number
): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds >= EPOCH_SECONDS_THRESHOLD
    ? Math.max(0, seconds * 1000 - now)
    : seconds * 1000;
}

/**
 * Classify a run-key response: the rate limit it reports when it is a 429 the
 * run-key limiter returned, else `undefined`, meaning do not retry. A 429 with
 * `x-vercel-mitigated` came from the firewall, not the limiter, so it gets no
 * in-process retry.
 */
export function getRunKeyRateLimit(response: {
  status: number;
  headers: Headers;
}): RunKeyRateLimit | undefined {
  const { status, headers } = response;
  if (status !== 429 || headers.has('x-vercel-mitigated')) return undefined;
  const retryAfter = parseRetryAfter(headers.get('retry-after'));
  return {
    retryAfterMs:
      retryAfter !== undefined
        ? Math.max(0, retryAfter) * 1000
        : parseRateLimitReset(headers.get('x-ratelimit-reset'), Date.now()),
  };
}

/**
 * Retry accounting for one `fetchRunKey` call. Holds per-call state, so create
 * one per call; it is never shared.
 */
export class RunKeyRateLimitRetry {
  readonly #target: string;
  #retries = 0;
  #waitedMs = 0;
  #deadlineMs: Promise<number | undefined> | undefined;
  #stopReason: string | undefined;

  /** `target` names what is being fetched, for the log line. */
  constructor(target: string) {
    this.#target = target;
  }

  /** Attempts made so far, counting the one that was just rejected. */
  get attempts(): number {
    return this.#retries + 1;
  }

  /** Why the last `wait()` declined to retry, for the surfaced error. */
  get stopReason(): string | undefined {
    return this.#stopReason;
  }

  /**
   * Wait out one rate-limited attempt. Resolves `true` after the wait, when
   * the caller should send the request again, or `false` without waiting when
   * the policy is exhausted and the caller should surface the 429.
   */
  async wait(rateLimit: RunKeyRateLimit): Promise<boolean> {
    if (this.attempts >= RUN_KEY_RETRY_MAX_ATTEMPTS) {
      return this.#stop(`no attempts left of ${RUN_KEY_RETRY_MAX_ATTEMPTS}`);
    }

    const baseMs =
      rateLimit.retryAfterMs ??
      RUN_KEY_RETRY_FALLBACK_BACKOFF_MS * 2 ** this.#retries;

    // Read on the first 429 only, so a call that is never throttled never
    // loads `@vercel/functions`.
    this.#deadlineMs ??= resolveDeadlineMs();
    const deadlineMs = await this.#deadlineMs;
    const untilDeadlineMs =
      deadlineMs === undefined
        ? Number.POSITIVE_INFINITY
        : deadlineMs - RUN_KEY_RETRY_DEADLINE_RESERVE_MS - Date.now();
    const availableMs = Math.min(
      RUN_KEY_RETRY_BUDGET_MS - this.#waitedMs,
      untilDeadlineMs
    );
    if (baseMs > availableMs) {
      return this.#stop(
        `the requested ${formatSeconds(baseMs)} wait exceeds the ${formatSeconds(
          Math.max(0, availableMs)
        )} left of the retry budget${
          untilDeadlineMs < RUN_KEY_RETRY_BUDGET_MS - this.#waitedMs
            ? " before the function's deadline"
            : ''
        }`
      );
    }

    const jitterMs =
      Math.random() *
      Math.max(
        RUN_KEY_RETRY_MIN_JITTER_MS,
        baseMs * RUN_KEY_RETRY_JITTER_RATIO
      );
    const waitMs = Math.round(Math.min(baseMs + jitterMs, availableMs));
    this.#retries++;
    this.#waitedMs += waitMs;
    // Visible rather than DEBUG-gated: this holds the caller for up to a
    // minute or more, which would otherwise read as an unexplained stall.
    console.warn(
      `[workflow] Rate limited (429) ${this.#target}; retrying in ${formatSeconds(
        waitMs
      )} (attempt ${this.attempts} of ${RUN_KEY_RETRY_MAX_ATTEMPTS})`
    );
    await sleep(waitMs);
    return true;
  }

  #stop(reason: string): false {
    this.#stopReason = `gave up after ${this.attempts} attempt${
      this.attempts === 1 ? '' : 's'
    } and ${formatSeconds(this.#waitedMs)} of waiting: ${reason}`;
    return false;
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
