import { Agent, RetryAgent } from 'undici';

let _dispatcher: RetryAgent | undefined;

/**
 * Returns a shared undici RetryAgent wrapping an Agent.
 *
 * - HTTP/2 multiplexing when the server supports it (via ALPN negotiation)
 * - Connection pooling: up to 128 connections per origin
 * - Retry: Automatic retry on 429/5xx with exponential backoff
 *
 * Note: HTTP/1.1 pipelining is disabled (pipelining: 1) because it causes
 * head-of-line blocking when concurrent request flows share a connection,
 * which deadlocks the webhook respondWith mechanism. HTTP/2 multiplexing
 * provides the same throughput benefit without this problem.
 *
 * IMPORTANT: This dispatcher must NOT be used with `duplex: 'half'`
 * streaming requests — undici's H2 client hangs when combined with
 * half-duplex streams. See streamer.ts for the streaming code path.
 */
export function getDispatcher(): RetryAgent {
  if (!_dispatcher) {
    _dispatcher = new RetryAgent(
      new Agent({
        allowH2: true,
        pipelining: 1,
        connections: 128,
        keepAliveTimeout: 10_000,
      }),
      {
        // Observe Retry-After header if received
        retryAfter: true,
        // Observe Retry-After header on 429 / 5xx responses.
        // Default status codes: 429 / 500 / 502 / 503 / 504.
      }
    );
  }
  return _dispatcher;
}
