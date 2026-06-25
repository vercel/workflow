import { Agent, RetryAgent, type RetryHandler } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;
let _eventsDispatcher: RetryAgent | undefined;
let _streamDispatcher: RetryAgent | undefined;

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
 * Retry options for stream writes (PUT). Stream appends are NOT idempotent, so
 * we must never retry a write the server may already have applied. We therefore
 * narrow undici's defaults to only the conditions that guarantee the request was
 * rejected *before* the chunk was persisted:
 *  - transient connection errors (undici's default `errorCodes`: ECONNRESET,
 *    ECONNREFUSED, ENOTFOUND, …) — the request never reached, or was not
 *    accepted by, the server, and
 *  - HTTP 429 — the server rejected the request outright (rate limited), so no
 *    chunk was written; honoring Retry-After backs off cleanly.
 *
 * Crucially, 5xx is excluded from the default `[500, 502, 503, 504, 429]`: a
 * 5xx can mean the chunk *was* written but the response failed, and a retry
 * would duplicate it. Other 4xx are client errors a retry can't fix. `methods`
 * is pinned to PUT (the only stream-write verb) for clarity; `errorCodes` is
 * left at undici's transient-network-error defaults. Exported so a test can
 * assert that 5xx never sneaks back into the retryable set.
 */
export const STREAM_RETRY_OPTIONS: RetryHandler.RetryOptions = {
  retryAfter: true,
  methods: ['PUT'],
  statusCodes: [429],
};

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
 * getDefaultStreamDispatcher (and STREAM_RETRY_OPTIONS) for its deliberately
 * narrowed retry policy — transient connection errors + HTTP 429 only, never
 * 5xx — chosen because stream appends are not idempotent.
 */
export function getStreamDispatcher(config?: APIConfig): unknown {
  return config?.dispatcher ?? getDefaultStreamDispatcher();
}

/** Build a shared undici RetryAgent wrapping an Agent with the given options. */
function makeRetryDispatcher(
  agentOptions: typeof DEFAULT_AGENT_OPTIONS | typeof EVENTS_AGENT_OPTIONS,
  retryOptions: RetryHandler.RetryOptions
): RetryAgent {
  return new RetryAgent(new Agent(agentOptions), retryOptions);
}

/**
 * Returns the shared default RetryAgent.
 *
 * - HTTP/1.1 (see DEFAULT_AGENT_OPTIONS)
 * - Connection pooling (up to 8 connections per origin)
 * - Retry: Automatic retry on 429/5xx or network errors with exponential backoff
 *   - Observes Retry-After header if received and lower than 30s
 */
function getDefaultDispatcher(): RetryAgent {
  _dispatcher ??= makeRetryDispatcher(
    DEFAULT_AGENT_OPTIONS,
    RETRY_AGENT_OPTIONS
  );
  return _dispatcher;
}

/**
 * Returns the shared HTTP/2 RetryAgent used by the v4 events API. Same retry /
 * pooling behavior as the default dispatcher, but with `allowH2` enabled.
 */
function getDefaultEventsDispatcher(): RetryAgent {
  _eventsDispatcher ??= makeRetryDispatcher(
    EVENTS_AGENT_OPTIONS,
    RETRY_AGENT_OPTIONS
  );
  return _eventsDispatcher;
}

/**
 * Returns the shared HTTP/2 RetryAgent used for stream writes (PUT write/close).
 *
 * Stream writes append chunks and are NOT idempotent, so this dispatcher uses a
 * deliberately narrowed retry policy (see STREAM_RETRY_OPTIONS): it retries only
 * on transient connection errors and HTTP 429 — both of which guarantee the
 * chunk was not persisted — and never on 5xx or other 4xx, where a retry could
 * duplicate an already-applied write. It opts into H2 (the write/close requests
 * send a fully-buffered body, or none, so they don't hit the duplex-streaming H2
 * issues that keep the long-lived live-read on plain `fetch`) by reusing the
 * events agent's H2 / pooling options.
 */
function getDefaultStreamDispatcher(): RetryAgent {
  _streamDispatcher ??= makeRetryDispatcher(
    EVENTS_AGENT_OPTIONS,
    STREAM_RETRY_OPTIONS
  );
  return _streamDispatcher;
}
