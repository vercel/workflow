import { Agent, RetryAgent } from 'undici';

let _dispatcher: RetryAgent | undefined;

/**
 * Returns a shared undici RetryAgent wrapping an Agent.
 *
 * - Connection pooling (up to 8 connections per origin)
 * - Retry: Automatic retry on 429/5xx or network errors with exponential backoff
 *   - Observes Retry-After header if received and lower than 30s
 *
 * Note: HTTP/2 is disabled because undici's experimental H2 support hangs
 * in certain Vercel runtime environments (sveltekit). HTTP/1.1 pipelining
 * is also disabled (pipelining: 1) because it causes head-of-line blocking
 * that deadlocks the webhook respondWith mechanism. The primary benefits
 * from undici here are retry logic and connection pooling.
 */
export function getDispatcher(): RetryAgent {
  if (!_dispatcher) {
    _dispatcher = new RetryAgent(
      new Agent({
        connections: 8,
        keepAliveTimeout: 10_000,
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
