import { Agent, RetryAgent, type RetryHandler } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;
let _eventsDispatcher: RetryAgent | undefined;
let _streamDispatcher: RetryAgent | undefined;
let _streamCloseDispatcher: RetryAgent | undefined;

/**
 * Time-to-first-byte cap for every request through the shared dispatcher.
 *
 * undici's default is 300_000 (5 minutes), which is longer than the queue's
 * default visibility timeout — so a single connection that goes quiet after the
 * request is written outlives the lease that the invocation is holding. The
 * message then redelivers and the run replays, which is observable as a ~305s
 * gap between two consecutive workflow events with no error recorded anywhere.
 *
 * 30s is deliberately well under both the queue's visibility-extension interval
 * (60s) and the per-request deadline in `makeRequest` (`REQUEST_TIMEOUT_MS`,
 * 60s), so a stalled socket surfaces as a typed, retryable
 * `UND_ERR_HEADERS_TIMEOUT` while callers still have time to react — rather than
 * as an opaque outer abort, or not at all.
 *
 * Override with `WORKFLOW_VERCEL_HEADERS_TIMEOUT_MS`; `0` disables the timeout.
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;

/**
 * Gap-between-body-chunks cap for every request through the shared dispatcher.
 * Same reasoning and same undici default (300_000) as the headers timeout. The
 * timer resets on each chunk received, so this bounds a stalled response body,
 * not the total transfer time — streamed event-log reads are unaffected as long
 * as the server keeps producing chunks.
 *
 * Override with `WORKFLOW_VERCEL_BODY_TIMEOUT_MS`; `0` disables the timeout.
 */
export const DEFAULT_BODY_TIMEOUT_MS = 30_000;

/**
 * Reads a non-negative integer millisecond override from the environment.
 * Anything unparseable or negative falls back to the default, so a typo can't
 * silently remove the timeout.
 */
function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Transport error codes retried in-process for idempotent methods.
 *
 * undici's defaults (everything up to `UND_ERR_SOCKET`) cover connection-level
 * failures but omit the timeout codes, so before this list existed a stalled
 * socket was never retried at all. The two timeout codes are ambiguous — the
 * request may have been fully processed — which is why they stay scoped to
 * `RetryAgent`'s default `methods` (GET/HEAD/OPTIONS/PUT/DELETE/TRACE, never
 * POST). The PUTs that reach the default and events dispatchers are the legacy
 * v1/v2 entity updates (cancel run, update step), which are idempotent in
 * outcome; stream appends — the one non-idempotent PUT — get their own
 * dispatcher whose retry policy deliberately excludes these codes (see
 * STREAM_RETRY_OPTIONS). POST event writes get their own type-aware retry
 * instead (see event-retry.ts).
 *
 * Exported so a test can assert the timeout codes stay in the list.
 */
export const RETRY_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];

/**
 * Retries after the initial attempt. undici's default is 5, which combined with
 * the timeout codes above would let one request burn 6 × the headers timeout
 * before failing. Three attempts keeps the worst case (~92s including backoff)
 * inside the queue's 300s visibility window even when a caller — e.g. the queue
 * client's acknowledge path — wraps the call in its own bounded retries.
 */
export const MAX_RETRIES = 2;

/**
 * Shared by every agent — connection pooling and the bounded transport
 * timeouts. Read from the environment on each call so the documented overrides
 * apply to all agents, and so tests can exercise them without duplicating the
 * constants.
 */
function getBaseAgentOptions() {
  return {
    connections: 8,
    keepAliveTimeout: 10_000,
    // HTTP/1.1 pipelining is disabled (pipelining: 1) because it causes
    // head-of-line blocking that deadlocks the webhook respondWith mechanism.
    pipelining: 1,
    headersTimeout: envTimeoutMs(
      'WORKFLOW_VERCEL_HEADERS_TIMEOUT_MS',
      DEFAULT_HEADERS_TIMEOUT_MS
    ),
    bodyTimeout: envTimeoutMs(
      'WORKFLOW_VERCEL_BODY_TIMEOUT_MS',
      DEFAULT_BODY_TIMEOUT_MS
    ),
  } as const;
}

/**
 * Options for the default undici Agent — the queue client (webhook
 * respondWith), v3 `makeRequest`, deployment resolution, and run-key fetch.
 * Exported (and read from the environment on each call) so tests can assert the
 * transport configuration and exercise it against a real socket without
 * duplicating the constants.
 *
 * HTTP/2 is intentionally OFF here: it deadlocks the webhook respondWith
 * mechanism and hangs duplex streaming in Vercel Functions (observed as 120s
 * E2E timeouts on the webhook/hook workflows). Only the events API and the
 * stream write/close path, which use neither mechanism, opt into H2 — see
 * getEventsAgentOptions.
 */
export function getAgentOptions() {
  return {
    ...getBaseAgentOptions(),
    allowH2: false,
  } as const;
}

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
 * earlier SvelteKit-on-Vercel-prod hang, which is why bundled consumers need
 * the `node:http2` require shim — see the nitro/sveltekit plugins).
 */
export function getEventsAgentOptions() {
  return {
    ...getBaseAgentOptions(),
    allowH2: true,
  } as const;
}

/**
 * Retry policy shared by the default and events dispatchers.
 *
 * Built on each call because it embeds MAX_RETRIES alongside the
 * environment-sensitive timeouts the codes below react to.
 */
function getRetryAgentOptions(): RetryHandler.RetryOptions {
  return {
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
    errorCodes: RETRY_ERROR_CODES,
    maxRetries: MAX_RETRIES,
  };
}

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
 * left at undici's transient-network-error defaults — deliberately *without*
 * RETRY_ERROR_CODES' two timeout codes, which are ambiguous about whether the
 * server processed the request. Exported so a test can assert that 5xx never
 * sneaks back into the retryable set.
 */
export const STREAM_RETRY_OPTIONS: RetryHandler.RetryOptions = {
  retryAfter: true,
  methods: ['PUT'],
  statusCodes: [429],
};

/**
 * Retry options for stream CLOSE (the `X-Stream-Done` PUT). Unlike chunk
 * appends, close is idempotent on the server: a duplicate close of a completed
 * stream early-returns, and the close-barrier protocol's durable `closing`
 * fence is an if_not_exists stamp that a re-entered close resumes — so a 5xx
 * whose effect may or may not have applied is safe to retry, and the server's
 * close barrier *relies* on it: a transient reconciliation failure (or an
 * unsafe close shape awaiting in-flight backups) is surfaced as a retriable
 * 503 with the stream left durably closing, expecting the writer to close
 * again. Without 5xx here, that 503 would reject `writer.close()` outright and
 * leave the stream fenced until run expiry. 429 keeps the same
 * pass-through-to-queue reasoning as chunk writes not applying: close is one
 * terminal request, so honoring Retry-After in-process is the cleaner
 * behavior. Exported so a test can pin the close-is-retriable contract.
 */
export const STREAM_CLOSE_RETRY_OPTIONS: RetryHandler.RetryOptions = {
  retryAfter: true,
  methods: ['PUT'],
  statusCodes: [429, 500, 502, 503, 504],
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
 * shared HTTP/2 events agent. See getEventsAgentOptions for why the events API
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

/**
 * Resolves the dispatcher for stream CLOSE: the caller's override, or the
 * shared close agent whose retry policy includes 5xx — close is idempotent
 * (see STREAM_CLOSE_RETRY_OPTIONS), unlike chunk appends.
 */
export function getStreamCloseDispatcher(config?: APIConfig): unknown {
  return config?.dispatcher ?? getDefaultStreamCloseDispatcher();
}

/**
 * Returns a shared undici RetryAgent wrapping an Agent.
 *
 * - HTTP/1.1 (see getAgentOptions)
 * - Connection pooling (up to 8 connections per origin)
 * - Timeouts: bounded time-to-first-byte and body-stall windows, replacing
 *   undici's 5-minute defaults
 * - Retry: Automatic retry on 5xx, network errors, and transport timeouts with
 *   exponential backoff (idempotent methods only — undici's default never
 *   retries POST), observing the `Retry-After` header when present.
 */
function getDefaultDispatcher(): RetryAgent {
  _dispatcher ??= new RetryAgent(
    new Agent(getAgentOptions()),
    getRetryAgentOptions()
  );
  return _dispatcher;
}

/**
 * Returns the shared HTTP/2 RetryAgent used by the v4 events API. Same retry /
 * pooling / timeout behavior as the default dispatcher, but with `allowH2`
 * enabled.
 */
function getDefaultEventsDispatcher(): RetryAgent {
  _eventsDispatcher ??= new RetryAgent(
    new Agent(getEventsAgentOptions()),
    getRetryAgentOptions()
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
  _streamDispatcher ??= new RetryAgent(
    new Agent(getEventsAgentOptions()),
    STREAM_RETRY_OPTIONS
  );
  return _streamDispatcher;
}

/** Shared agent for the idempotent stream close (5xx retriable). */
function getDefaultStreamCloseDispatcher(): RetryAgent {
  _streamCloseDispatcher ??= new RetryAgent(
    new Agent(getEventsAgentOptions()),
    STREAM_CLOSE_RETRY_OPTIONS
  );
  return _streamCloseDispatcher;
}
