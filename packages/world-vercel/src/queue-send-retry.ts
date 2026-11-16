/**
 * In-process retry for queue sends.
 *
 * Nothing else retries a send. The queue client's undici `RetryAgent` never
 * retries a POST, and `@vercel/queue` makes one `fetch` per send. So a send
 * that lands on a pooled connection the peer has already closed (a Fluid
 * instance thawed after its sockets went stale, a connection reset mid-flight)
 * fails within milliseconds, without the queue ever seeing it, and the error
 * goes straight to the caller.
 *
 * For most sends the caller recovers: a send inside a queue delivery fails the
 * delivery, and its redelivery sends again. `start()` cannot. Its `run_created`
 * write runs beside the send and has usually committed by the time the send
 * fails, so the failed start leaves a run that exists and was never queued. A
 * caller that retries (a step does, with a new run ID) starts a second run, and
 * the first stays pending for good.
 *
 * Re-sending is safe for every message this World sends: a step message or a
 * wait timer carries an idempotency key, so a re-send of one that did land is
 * dropped by the queue's deduplication; an orchestrator message carries none,
 * and a duplicate one is a spare wake, which every runtime tolerates (the queue
 * delivers at least once anyway).
 *
 * Only transient failures are retried: a transport failure, this World's own
 * per-request deadline, a 5xx, a 429 and the queue's consumer-discovery 502.
 * A 4xx means the queue decided, and re-sending changes nothing.
 */

import { QUEUE_REQUEST_DEADLINE_CODE } from './http-client.js';
import { getTransientTransportCode } from './http-core.js';

/** Attempts per send, the first included. */
export const QUEUE_SEND_MAX_ATTEMPTS = 3;

/** Backoff before the n-th retry (index 0 is the first retry). */
export const QUEUE_SEND_RETRY_DELAYS_MS: readonly number[] = [100, 500];

/** Random spread added to each backoff, so concurrent senders do not align. */
const QUEUE_SEND_RETRY_JITTER_MS = 100;

/**
 * No retry starts once this long has passed since the first attempt. Leaves
 * room for one retry after a send that ran into the 30s queue-request
 * deadline, and none after two, so a hung queue holds a caller at most about
 * a minute rather than three deadlines' worth.
 */
export const QUEUE_SEND_RETRY_BUDGET_MS = 35_000;

/** Ceiling on a 429's `Retry-After` honored in-process. */
const QUEUE_SEND_MAX_RETRY_AFTER_MS = 5_000;

/**
 * `@vercel/queue`'s error classes, matched by `name`: a bundle can carry two
 * copies of the package, and `instanceof` fails across them.
 */
function queueErrorName(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : undefined;
}

function hasCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * How long to wait before re-sending after `error`, or `undefined` when the
 * error is not worth a re-send.
 */
export function queueSendRetryDelayMs(
  error: unknown,
  retry: number
): number | undefined {
  const backoff =
    (QUEUE_SEND_RETRY_DELAYS_MS[retry] ??
      QUEUE_SEND_RETRY_DELAYS_MS[QUEUE_SEND_RETRY_DELAYS_MS.length - 1] ??
      0) + Math.floor(Math.random() * QUEUE_SEND_RETRY_JITTER_MS);
  const name = queueErrorName(error);
  if (name === 'TooManyRequestsError') {
    const { retryAfter } = error as { retryAfter?: unknown };
    const retryAfterMs =
      typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter * 1000 : 0;
    // A longer wait is left to the caller: the queue asked for it.
    if (retryAfterMs > QUEUE_SEND_MAX_RETRY_AFTER_MS) return undefined;
    return Math.max(backoff, retryAfterMs);
  }
  if (
    // Any 5xx, and the queue's 502 when it could not discover the target
    // deployment's consumers.
    name === 'InternalServerError' ||
    name === 'ConsumerDiscoveryError' ||
    getTransientTransportCode(error) !== undefined ||
    hasCode(error, QUEUE_REQUEST_DEADLINE_CODE)
  ) {
    return backoff;
  }
  return undefined;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `send`, re-running it after a transient failure (see the module
 * comment). The last error is thrown once the attempts or the budget run out.
 */
export async function withQueueSendRetry<T>(
  send: () => Promise<T>,
  options: {
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  } = {}
): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= QUEUE_SEND_MAX_ATTEMPTS) throw error;
      const delayMs = queueSendRetryDelayMs(error, attempt - 1);
      if (delayMs === undefined) throw error;
      if (Date.now() - startedAt + delayMs > QUEUE_SEND_RETRY_BUDGET_MS) {
        throw error;
      }
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
