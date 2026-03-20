import { Agent, RetryAgent } from 'undici';

let _dispatcher: RetryAgent | undefined;

/**
 * Returns a shared undici RetryAgent wrapping an Agent.
 *
 * - Connection pooling (up to 8 connections per origin)
 * - Retry: Automatic retry on 429/5xx or network errors with exponential backoff
 *   - Observes Retry-After header if received and lower than 30s
 */
export function getDispatcher(): RetryAgent {
  if (!_dispatcher) {
    _dispatcher = new RetryAgent(
      new Agent({
        connections: 8,
        keepAliveTimeout: 10_000,
        // H2 is specifically incompatible with SvelteKit on Vercel prod. Everything else
        // runs fine.
        // TODO: Investigate/fix the failure on SvelteKit so we can re-enable H2.
        allowH2: false,
        // HTTP/1.1 pipelining is disabled (pipelining: 1) because it causes
        // head-of-line blocking that deadlocks the webhook respondWith mechanism.
        pipelining: 1,
      }),
      {
        // Observe Retry-After header if received
        retryAfter: true,
        // By default, we observe re-try headers, and also separately
        // re-try on these status codes: 429 / 500 / 502 / 503 / 504.
        // TODO: We might want to let 429s pass through, so that we can do
        // runtime retry-after handling through the queue.
      }
    );
  }
  return _dispatcher;
}
