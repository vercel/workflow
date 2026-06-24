import { Agent, RetryAgent } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;
let _eventsDispatcher: RetryAgent | undefined;
let _streamDispatcher: Agent | undefined;

/** Shared between both agents — connection pooling and H1 pipelining tuning. */
const BASE_AGENT_OPTIONS = {
  connections: 8,
  keepAliveTimeout: 10_000,
  // HTTP/1.1 pipelining is disabled (pipelining: 1) because it causes
  // head-of-line blocking that deadlocks the webhook respondWith mechanism.
  pipelining: 1,
};

/**
 * Options for the default undici Agent — the queue client (webhook
 * respondWith), v3 `makeRequest`, deployment resolution, and run-key fetch.
 * Exported so tests can assert the transport configuration.
 *
 * HTTP/2 is intentionally OFF here: it deadlocks the webhook respondWith
 * mechanism and hangs duplex streaming in Vercel Functions (observed as 120s
 * E2E timeouts on the webhook/hook workflows). Only the events API, which
 * doesn't use those mechanisms, opts into H2 — see EVENTS_AGENT_OPTIONS.
 */
export const DEFAULT_AGENT_OPTIONS = {
  ...BASE_AGENT_OPTIONS,
  allowH2: false,
} as const;

/**
 * Options for the events API undici Agent. Exported so tests can assert that
 * HTTP/2 stays enabled.
 *
 * The v4 events endpoints are the hottest path (an event write per step
 * transition, plus event-log reads on replay) and are plain request/response —
 * or, for LIST, a streamed *response* — none of which trip the webhook /
 * duplex-streaming H2 issues that keep the default agent on H1. Multiplexing
 * removes per-request connection setup and head-of-line blocking here.
 * Re-enabling H2 more broadly is gated on resolving those issues (notably the
 * earlier SvelteKit-on-Vercel-prod hang).
 */
export const EVENTS_AGENT_OPTIONS = {
  ...BASE_AGENT_OPTIONS,
  allowH2: true,
} as const;

const RETRY_AGENT_OPTIONS = {
  // Observe Retry-After header if received
  retryAfter: true,
  // By default, we observe re-try headers, and also separately
  // re-try on these status codes: 429 / 500 / 502 / 503 / 504.
  // TODO: We might want to let 429s pass through, so that we can do
  // runtime retry-after handling through the queue.
} as const;

/**
 * Resolves the undici dispatcher for a request: the caller's override, or the
 * shared default agent (HTTP/1.1).
 */
export function getDispatcher(config?: APIConfig): unknown {
  return config?.dispatcher ?? getDefaultDispatcher();
}

/**
 * Resolves the dispatcher for the v4 events API: the caller's override, or the
 * shared HTTP/2 events agent. See EVENTS_AGENT_OPTIONS for why the events API
 * uses H2 while the default path stays on H1.
 */
export function getEventsDispatcher(config?: APIConfig): unknown {
  return config?.dispatcher ?? getDefaultEventsDispatcher();
}

/**
 * Resolves the dispatcher for stream writes (the PUT write/close path): the
 * caller's override, or the shared HTTP/2 stream agent. See
 * getDefaultStreamDispatcher for why this is a bare Agent (no retry).
 */
export function getStreamDispatcher(config?: APIConfig): unknown {
  return config?.dispatcher ?? getDefaultStreamDispatcher();
}

/**
 * Returns a shared undici RetryAgent wrapping an Agent.
 *
 * - HTTP/1.1 (see DEFAULT_AGENT_OPTIONS)
 * - Connection pooling (up to 8 connections per origin)
 * - Retry: Automatic retry on 429/5xx or network errors with exponential backoff
 *   - Observes Retry-After header if received and lower than 30s
 */
function getDefaultDispatcher(): RetryAgent {
  if (!_dispatcher) {
    _dispatcher = new RetryAgent(
      new Agent(DEFAULT_AGENT_OPTIONS),
      RETRY_AGENT_OPTIONS
    );
  }
  return _dispatcher;
}

/**
 * Returns the shared HTTP/2 RetryAgent used by the v4 events API. Same retry /
 * pooling behavior as the default dispatcher, but with `allowH2` enabled.
 */
function getDefaultEventsDispatcher(): RetryAgent {
  if (!_eventsDispatcher) {
    _eventsDispatcher = new RetryAgent(
      new Agent(EVENTS_AGENT_OPTIONS),
      RETRY_AGENT_OPTIONS
    );
  }
  return _eventsDispatcher;
}

/**
 * Returns the shared HTTP/2 Agent used for stream writes (PUT write/close).
 *
 * Unlike the default and events dispatchers, this is a bare `Agent` *without*
 * the RetryAgent wrapper: stream writes append chunks and are not idempotent,
 * so an automatic retry of a write the server already received would duplicate
 * chunks. We keep undici's retry off here (matching the streamer's original
 * plain-`fetch` behavior) and only opt into H2 — the write/close requests send
 * a fully-buffered body (or none), so they don't hit the duplex-streaming H2
 * issues that keep the long-lived live-read on plain `fetch`. Reuses the events
 * agent's H2 / pooling options.
 */
function getDefaultStreamDispatcher(): Agent {
  if (!_streamDispatcher) {
    _streamDispatcher = new Agent(EVENTS_AGENT_OPTIONS);
  }
  return _streamDispatcher;
}
