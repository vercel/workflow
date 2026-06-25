import { createRequire } from 'node:module';
import { Agent, RetryAgent, type RetryHandler } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;
let _eventsDispatcher: RetryAgent | undefined;
let _streamDispatcher: RetryAgent | undefined;

// undici loads most node: builtins as ESM imports, but pulls in `node:http2`
// lazily via a bare `require('node:http2')` inside a try/catch. When this
// package is bundled into an ESM server output (a custom Vite/Rollup/esbuild
// build, or a framework integration that doesn't externalize undici), there is
// no `require` in that scope: the call throws, undici swallows it and falls
// back to a stub whose `http2.connect` is undefined — silently breaking every
// HTTP/2 request (our events API and stream writes), which then hang on a dead
// connection through RetryAgent's backoff (~16s) and fail.
//
// Install a working global `require` so undici's bare require resolves the real
// builtin, regardless of how a consumer bundles us. This is the same mechanism
// the @workflow framework integrations apply via a build banner, but lives here
// so it travels with the package and protects *any* bundled consumer — not just
// the integrations we ship. The `typeof require === 'function'` guard makes it a
// no-op wherever a real `require` already exists (every CJS context), and we
// install a real `createRequire`, never a stub. The base path passed to
// `createRequire` is irrelevant for resolving a builtin like `node:http2`.
//
// `globalThis.require` becoming defined makes `typeof require` truthy for every
// other bundled dependency too; that is acceptable because the value is a
// functional `require`, so a library that switches to a CJS path gets a working
// one. Runs once at module load — before any Agent is constructed, and well
// before undici's lazy http2 require fires at first connect.
type GlobalWithRequire = typeof globalThis & { require?: NodeRequire };

function ensureGlobalRequireForUndiciH2(): void {
  const g = globalThis as GlobalWithRequire;
  if (typeof g.require === 'function') return;
  try {
    g.require = createRequire(import.meta.url);
  } catch {
    // `node:module` / `import.meta` unavailable (e.g. an edge runtime). The
    // HTTP/1.1 fallback below keeps requests working without H2.
  }
}

ensureGlobalRequireForUndiciH2();

/**
 * Whether undici can actually negotiate HTTP/2 in this runtime — i.e. whether
 * `node:http2` resolves to the real builtin (with a `connect` function) rather
 * than the undefined stub undici falls back to in an un-wired ESM bundle. Used
 * to downgrade H2 dispatchers to HTTP/1.1 instead of failing. Exported for
 * tests.
 */
export function isHttp2Available(): boolean {
  const req = (globalThis as GlobalWithRequire).require;
  if (typeof req !== 'function') return false;
  try {
    const http2 = req('node:http2') as { connect?: unknown };
    return typeof http2.connect === 'function';
  } catch {
    return false;
  }
}

/**
 * Pure decision helper: an H2-requesting dispatcher must fall back to HTTP/1.1
 * exactly when H2 was requested but `node:http2` is not usable. Exported for
 * tests.
 */
export function shouldFallBackToH1(
  requestedAllowH2: boolean,
  http2Available: boolean
): boolean {
  return requestedAllowH2 === true && !http2Available;
}

let _warnedH2Fallback = false;

/**
 * Resolve the Agent options for a dispatcher that requests HTTP/2, downgrading
 * `allowH2` to false (and warning once) when `node:http2` can't be loaded.
 * Keeps requests working on HTTP/1.1 instead of failing on a dead H2
 * connection. Leaves the exported `*_AGENT_OPTIONS` constants untouched.
 */
function resolveH2AgentOptions(
  options: typeof EVENTS_AGENT_OPTIONS
): Agent.Options {
  if (!shouldFallBackToH1(options.allowH2, isHttp2Available())) {
    return options;
  }
  if (!_warnedH2Fallback) {
    _warnedH2Fallback = true;
    console.warn(
      "[workflow:world-vercel] node:http2 is unavailable, so undici can't " +
        'negotiate HTTP/2 — falling back to HTTP/1.1. This usually means ' +
        'world-vercel was bundled into an ESM server where undici’s lazy ' +
        "require('node:http2') was left un-wired. Requests still work on " +
        'HTTP/1.1; to restore H2, ensure a global `require` exists in the ' +
        'server bundle (e.g. a createRequire-backed banner).'
    );
  }
  return { ...options, allowH2: false };
}

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
      new Agent(resolveH2AgentOptions(EVENTS_AGENT_OPTIONS)),
      RETRY_AGENT_OPTIONS
    );
  }
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
  if (!_streamDispatcher) {
    _streamDispatcher = new RetryAgent(
      new Agent(resolveH2AgentOptions(EVENTS_AGENT_OPTIONS)),
      STREAM_RETRY_OPTIONS
    );
  }
  return _streamDispatcher;
}
