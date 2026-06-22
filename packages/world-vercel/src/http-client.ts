import { Agent, RetryAgent } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;

/**
 * Options for the shared default undici Agent. Exported so tests can assert the
 * transport configuration (notably that HTTP/2 stays enabled).
 */
export const DEFAULT_AGENT_OPTIONS = {
  connections: 8,
  keepAliveTimeout: 10_000,
  // HTTP/2 is enabled for every dispatcher-backed request path (v3 makeRequest,
  // v4 events, the queue client, deployment resolution, run-key fetch).
  // Multiplexing removes per-request connection setup and head-of-line blocking
  // against the backend. It was previously disabled because it hung SvelteKit on
  // Vercel prod; we now enable it everywhere and rely on the E2E suite (the
  // SvelteKit Vercel Prod lane in particular) to guard the regression.
  // The streaming paths in streamer.ts deliberately bypass this dispatcher —
  // duplex streaming is incompatible with undici's H2 — and are unaffected.
  allowH2: true,
  // HTTP/1.1 pipelining is disabled (pipelining: 1) because it causes
  // head-of-line blocking that deadlocks the webhook respondWith mechanism on
  // the H1 fallback path. Orthogonal to H2, which multiplexes natively.
  pipelining: 1,
} as const;

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
 * - HTTP/2 enabled (see DEFAULT_AGENT_OPTIONS)
 * - Connection pooling (up to 8 connections per origin)
 * - Retry: Automatic retry on 429/5xx or network errors with exponential backoff
 *   - Observes Retry-After header if received and lower than 30s
 */
function getDefaultDispatcher(): RetryAgent {
  if (!_dispatcher) {
    _dispatcher = new RetryAgent(new Agent(DEFAULT_AGENT_OPTIONS), {
      // Observe Retry-After header if received
      retryAfter: true,
      // By default, we observe re-try headers, and also separately
      // re-try on these status codes: 429 / 500 / 502 / 503 / 504.
      // TODO: We might want to let 429s pass through, so that we can do
      // runtime retry-after handling through the queue.
    });
  }
  return _dispatcher;
}
