import { Agent, RetryAgent, type RetryHandler } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;

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
 * POST). The PUTs that go through this dispatcher are the legacy v1/v2 entity
 * updates (cancel run, update step), which are idempotent in outcome; stream
 * appends — the one non-idempotent PUT — bypass the dispatcher entirely (see
 * streamer.ts). POST event writes get their own type-aware retry instead (see
 * event-retry.ts).
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
 * Options for the shared undici Agent. Exported (and read from the environment
 * on each call) so tests can assert the transport configuration and exercise it
 * against a real socket without duplicating the constants.
 */
export function getAgentOptions() {
  return {
    connections: 8,
    keepAliveTimeout: 10_000,
    // H2 is specifically incompatible with SvelteKit on Vercel prod. Everything else
    // runs fine.
    // TODO: Investigate/fix the failure on SvelteKit so we can re-enable H2.
    allowH2: false,
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
 * - Timeouts: bounded time-to-first-byte and body-stall windows, replacing
 *   undici's 5-minute defaults
 * - Retry: Automatic retry on 5xx, network errors, and transport timeouts with
 *   exponential backoff (idempotent methods only — undici's default never
 *   retries POST), observing the `Retry-After` header when present.
 */
function getDefaultDispatcher(): RetryAgent {
  if (!_dispatcher) {
    const retryOptions: RetryHandler.RetryOptions = {
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
    _dispatcher = new RetryAgent(new Agent(getAgentOptions()), retryOptions);
  }
  return _dispatcher;
}
