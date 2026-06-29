import { Agent, RetryAgent } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;

/**
 * Resolves the undici dispatcher for a request: the caller's override, or the
 * shared default agent.
 */
export function getDispatcher(config?: APIConfig): unknown {
  return config?.dispatcher ?? getDefaultDispatcher();
}

/**
 * Returns a shared undici RetryAgent wrapping an Agent.
 *
 * - Connection pooling (up to 8 connections per origin)
 * - Retry: Automatic retry on 5xx or network errors with exponential backoff
 *   (idempotent methods only — undici's default never retries POST), observing
 *   the `Retry-After` header when present.
 */
function getDefaultDispatcher(): RetryAgent {
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
        // Retry 5xx in-process (genuine transient blips recover fast), but NOT
        // 429. The Vercel firewall issues a challenge as a 429: our
        // server-to-server client cannot solve a challenge, so in-process
        // retries just re-trigger it ~5× per request and amplify load against
        // an already-overloaded firewall during an incident. Letting 429 pass
        // through surfaces it immediately to makeRequest — which maps it to a
        // ThrottleError carrying the `x-vercel-mitigated` / `x-vercel-id`
        // headers — and the queue does the (backed-off) retry instead.
        // (undici default is [500, 502, 503, 504, 429].)
        statusCodes: [500, 502, 503, 504],
      }
    );
  }
  return _dispatcher;
}
