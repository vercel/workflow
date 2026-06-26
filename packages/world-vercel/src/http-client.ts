import { createRequire } from 'node:module';
import { Agent, RetryAgent, type RetryHandler } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;
let _eventsDispatcher: RetryAgent | undefined;
let _streamDispatcher: RetryAgent | undefined;
let _streamH1Dispatcher: RetryAgent | undefined;

// undici loads most node: builtins as ESM imports, but pulls in `node:http2`
// lazily via a bare `require('node:http2')` inside a try/catch. When this
// package is bundled into an ESM server output (a custom Vite/Rollup/esbuild
// build, or a framework integration that doesn't externalize undici), there is
// no `require` in that scope: the call throws, undici swallows it and falls
// back to a stub whose `http2.connect` is undefined — so the first HTTP/2
// connect attempt throws `http2.connect is not a function`, which surfaces
// (after undici's ~16s connect-retry backoff) as a failed request.
//
// Install a working global `require` so undici's bare require resolves the real
// builtin. This is a best-effort H2 *preserver*: where undici's bundled
// `require` is a free identifier (it resolves to this global), it restores real
// HTTP/2; where the bundler rewrote it to a tool-injected per-chunk binding
// this global never reaches (notably nitro/rollup), it has no effect there.
//
// It is therefore NOT a correctness mechanism on its own. Correctness is
// guaranteed by the runtime HTTP/2 -> HTTP/1.1 fallback in
// `fetchWithH2Fallback` below, which recovers regardless of how the bundler
// bound undici's `require`. The framework build banners (@workflow/sveltekit,
// @workflow/nitro, @workflow/web) remain the way to keep full H2 performance in
// the bundlers we ship builders for; this global + the runtime fallback are the
// catch-all for arbitrary bundled consumers we don't.
//
// The `typeof require === 'function'` guard makes it a no-op wherever a real
// `require` already exists (every CJS context), and we install a real
// `createRequire`, never a stub. The base path passed to `createRequire` is
// irrelevant for resolving a builtin like `node:http2`.
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
    // runtime HTTP/1.1 fallback keeps requests working without H2.
  }
}

ensureGlobalRequireForUndiciH2();

/**
 * True when `err` — or any `cause` in its chain — is the TypeError undici
 * throws when it cannot load `node:http2` and falls back to a stub whose
 * `connect` is undefined: `http2.connect is not a function`.
 *
 * This is the bundling failure signature (see the module-level comment): the
 * first HTTP/2 connect attempt calls `http2.connect(...)` on the stub and
 * throws, which the global `fetch` surfaces as `TypeError: fetch failed` with
 * the original TypeError as `cause`. We match the `connect is not a function`
 * suffix rather than the full `http2.connect …` text because a minifier may
 * rename undici's `http2` binding but cannot rename the `.connect` property
 * access. Exported for tests.
 */
export function isHttp2ConnectUnavailableError(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 6; depth++) {
    if (
      cur instanceof Error &&
      /connect is not a function/i.test(cur.message)
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

let _h2Disabled = false;
let _warnedH2Fallback = false;

/**
 * Permanently route the H2 paths (v4 events, stream writes) through HTTP/1.1
 * for the rest of this process after undici proved unable to establish HTTP/2,
 * warning once. Called by `fetchWithH2Fallback` on the first connect failure so
 * later requests skip the dead H2 attempt (and its ~16s connect-retry backoff)
 * entirely.
 */
function disableH2(): void {
  _h2Disabled = true;
  if (_warnedH2Fallback) return;
  _warnedH2Fallback = true;
  console.warn(
    "[workflow:world-vercel] undici couldn't establish HTTP/2 (node:http2 was " +
      'not loadable) — falling back to HTTP/1.1 for the rest of this process. ' +
      'This usually means world-vercel was bundled into an ESM server where ' +
      "undici's lazy require('node:http2') was left un-wired. Requests keep " +
      'working on HTTP/1.1; to restore HTTP/2 multiplexing, ensure a global ' +
      '`require` exists in the server bundle (e.g. a createRequire-backed ' +
      'banner — see @workflow/sveltekit, @workflow/nitro, @workflow/web).'
  );
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
 *
 * Prefer routing v4 requests through `fetchWithH2Fallback('events', …)`, which
 * uses this dispatcher but transparently downgrades to HTTP/1.1 if undici can't
 * negotiate H2 in the current bundle.
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
 *
 * Prefer routing stream writes through `fetchWithH2Fallback('stream', …)`,
 * which uses this dispatcher but transparently downgrades to HTTP/1.1 (keeping
 * the same narrowed retry policy) if undici can't negotiate H2.
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
      new Agent(EVENTS_AGENT_OPTIONS),
      STREAM_RETRY_OPTIONS
    );
  }
  return _streamDispatcher;
}

/**
 * HTTP/1.1 twin of the stream-write dispatcher, used as the fallback when
 * undici can't negotiate H2. It must preserve the non-idempotent-safe
 * STREAM_RETRY_OPTIONS (the default dispatcher retries 5xx, which would risk
 * duplicating a stream append), so it pairs an H1 Agent with those same retry
 * options. The events fallback, by contrast, can reuse getDefaultDispatcher()
 * because DEFAULT_AGENT_OPTIONS is exactly EVENTS_AGENT_OPTIONS with H2 off and
 * the same RETRY_AGENT_OPTIONS.
 */
function getDefaultStreamH1Dispatcher(): RetryAgent {
  if (!_streamH1Dispatcher) {
    _streamH1Dispatcher = new RetryAgent(
      new Agent(DEFAULT_AGENT_OPTIONS),
      STREAM_RETRY_OPTIONS
    );
  }
  return _streamH1Dispatcher;
}

/** The two world-vercel request paths that opt into HTTP/2. */
export type H2Path = 'events' | 'stream';

function h2DispatcherFor(path: H2Path): RetryAgent {
  return path === 'events'
    ? getDefaultEventsDispatcher()
    : getDefaultStreamDispatcher();
}

function h1FallbackFor(path: H2Path): RetryAgent {
  return path === 'events'
    ? getDefaultDispatcher()
    : getDefaultStreamH1Dispatcher();
}

function fetchWith(
  input: string | URL,
  init: RequestInit,
  dispatcher: unknown
): Promise<Response> {
  return fetch(input, {
    ...init,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
    dispatcher,
  } as any);
}

/**
 * Issue a `fetch` over the HTTP/2 dispatcher for `path`, transparently
 * downgrading to HTTP/1.1 if undici can't negotiate H2 in this runtime.
 *
 * The H2-broken case (world-vercel bundled into an ESM server where undici's
 * lazy `require('node:http2')` was left un-wired) manifests as the first
 * connect attempt throwing `http2.connect is not a function`
 * (`isHttp2ConnectUnavailableError`). That failure happens at connection
 * establishment — *before* any request bytes are sent — so retrying the exact
 * same request on an HTTP/1.1 dispatcher is safe even for the non-idempotent
 * stream writes: nothing reached the server. The fallback decision is then
 * cached process-wide (`disableH2`) so subsequent requests skip the dead H2
 * attempt and its ~16s connect-retry backoff.
 *
 * Callers must pass a replayable (buffered, non-stream) body, since the request
 * may be issued twice; every current caller does (v4 events send an encoded
 * buffer or no body; stream writes send a fully-buffered body or none).
 *
 * A caller-supplied `config.dispatcher` override replaces every default,
 * including this fallback: it's used verbatim with no H2/H1 substitution.
 */
export async function fetchWithH2Fallback(
  path: H2Path,
  input: string | URL,
  init: RequestInit,
  config?: APIConfig
): Promise<Response> {
  const override = config?.dispatcher;
  if (override !== undefined) {
    return fetchWith(input, init, override);
  }
  if (_h2Disabled) {
    return fetchWith(input, init, h1FallbackFor(path));
  }
  try {
    return await fetchWith(input, init, h2DispatcherFor(path));
  } catch (err) {
    if (!isHttp2ConnectUnavailableError(err)) throw err;
    disableH2();
    return fetchWith(input, init, h1FallbackFor(path));
  }
}
