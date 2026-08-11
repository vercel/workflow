import { Agent, Dispatcher, RetryAgent, type RetryHandler } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;
let _streamDispatcher: RetryAgent | undefined;
let _streamCloseDispatcher: RetryAgent | undefined;

/**
 * Shared between all agents — connection pooling only. `pipelining` is
 * deliberately NOT set here: undici overloads that single option to mean both
 * "H1 pipelining depth" and "max in-flight H2 streams per connection", and the
 * two paths want opposite values. Each agent sets it explicitly below.
 */
const BASE_AGENT_OPTIONS = {
  connections: 8,
  keepAliveTimeout: 10_000,
};

/**
 * H2 *receive* flow-control windows for the events agent, in bytes.
 *
 * undici defaults to a 256 KiB stream window and a 512 KiB connection window.
 * Both are far below the bandwidth-delay product of this path: a Vercel Function
 * sees roughly 9 ms RTT to the edge (measured from iad1 against
 * edge-terminated routes), so once a response exceeds the window the origin has
 * to stop and wait for a WINDOW_UPDATE, costing a round trip per window's worth
 * of body. Event-log reads on replay are exactly that shape.
 *
 * The two windows have to be raised together, because whichever is left small
 * becomes the binding constraint on its own:
 *  - a single read (one in-flight stream) is capped by the *stream* window;
 *    raising only the connection window changes nothing.
 *  - concurrent reads share the *connection* window; raising only the stream
 *    window just relocates the stall to the connection level, and measured
 *    slightly *worse* than leaving both alone.
 * Measured against a loopback H2 origin mirroring the edge's SETTINGS at 10 ms
 * RTT, these cut read wall time by 76–86% versus undici's defaults across 1, 4
 * and 32 concurrent reads, against noise floors of 0.3–3.9%.
 *
 * These are set through the flat `initialWindowSize`/`connectionWindowSize`
 * options even though undici 8.10 marks them `@deprecated` in favour of
 * `h2Options`. The replacement the deprecation names does not work: undici reads
 * `h2Options.initialWindowSize`, while it *validates* — and its types document —
 * `h2Options.settings.initialWindowSize`, so the documented spelling is accepted
 * and then silently ignored. Measured against a loopback H2 origin, the flat
 * option puts 4 MiB on the wire and `h2Options.settings.initialWindowSize` leaves
 * the server seeing undici's 256 KiB default. Revisit once upstream aligns them.
 *
 * Sizing: the stream window is what binds a single read, and 4 MiB captures that
 * win in full (a 4 MiB page goes from 216 ms to 17 ms; 2 MiB only reaches 29 ms).
 * That single-read shape is the one replay actually produces, since event-log
 * pages are read sequentially and page size is server-driven with no byte cap, so
 * a page carrying large step payloads can be multiple MiB. The connection window
 * has to be several times the stream window or concurrent reads stall on it
 * instead — at 32 concurrent reads 8 MiB is no better than 1 MiB/8 MiB while
 * 16 MiB is 25% faster, and 32 MiB adds nothing further.
 *
 * Cost: a receive window is a ceiling on how many unacked bytes the origin may
 * have in flight toward this process, so 8 connections x 16 MiB bounds the
 * transport's worst-case buffering. Under an adversarial slow consumer (8
 * concurrent 8 MiB bodies read one chunk per ms) peak RSS measured ~60–100 MiB
 * above the smaller settings. It is a ceiling rather than an allocation, and only
 * fills when the origin outruns the consumer; the events readers decode a whole
 * response body anyway, so those bytes reach app memory either way. The write
 * path is unaffected — receive windows don't govern uploads, and with four
 * interleaved controls every setting lands within a 1.3% noise floor.
 */
const H2_STREAM_WINDOW_BYTES = 4 * 1024 * 1024;
const H2_CONNECTION_WINDOW_BYTES = 16 * 1024 * 1024;

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
  // HTTP/1.1 pipelining is disabled (pipelining: 1) because it causes
  // head-of-line blocking that deadlocks the webhook respondWith mechanism.
  pipelining: 1,
} as const;

/**
 * Options for the events API undici Agent. Exported so tests can assert that
 * HTTP/2 stays enabled *and* that it is actually configured to multiplex.
 *
 * The v4 events endpoints are the hottest path (an event write per step
 * transition, plus event-log reads on replay) and are plain request/response —
 * or, for LIST, a streamed *response* — none of which trip the webhook /
 * duplex-streaming H2 issues that keep the default agent on H1. Multiplexing
 * removes per-request connection setup and head-of-line blocking here.
 * Re-enabling H2 more broadly is gated on resolving those issues (notably the
 * earlier SvelteKit-on-Vercel-prod hang).
 *
 * `pipelining` is deliberately not set. undici picks the per-connection
 * in-flight ceiling protocol-aware (`getMaxConcurrent` in `client.js`): on H2 it
 * is the peer's SETTINGS_MAX_CONCURRENT_STREAMS, and `pipelining` only applies
 * before a protocol has been negotiated, where the H1 default of 1 is the safe
 * value. The Vercel edge advertises SETTINGS_MAX_CONCURRENT_STREAMS 160, so the
 * ceiling is not the binding constraint. Measured against a loopback H2 origin,
 * 16 concurrent requests run as 16 parallel streams on one connection with no
 * `pipelining` set at all.
 *
 * Multiplexing interacts with flow control, which is why the receive windows are
 * raised here. Concentrating N streams onto one connection makes them share that
 * connection's single receive window, so the download side gets *worse* as
 * multiplexing improves unless the window grows with it: at 32 concurrent reads,
 * one-stream-per-connection measured 70% faster than multiplexing purely because
 * spreading streams over 8 connections gave them 8 separate windows. Raising the
 * windows removes that trade-off — the multiplexed agent then beats both.
 */
export const EVENTS_AGENT_OPTIONS = {
  ...BASE_AGENT_OPTIONS,
  allowH2: true,
  initialWindowSize: H2_STREAM_WINDOW_BYTES,
  connectionWindowSize: H2_CONNECTION_WINDOW_BYTES,
} as const;

/**
 * Events-agent options with HTTP/2 off entirely — what `WORKFLOW_H2_MULTIPLEX=0`
 * selects. Identical to the H1 default agent, so the kill switch puts the events
 * path back on the transport it used before H2 was enabled there.
 *
 * Leaving `allowH2: true` and only skipping the multiplexing interceptor is not a
 * mitigation for an H2 transport fault: undici never evicts an HTTP/2 session
 * when a stream times out (`client-h2.js`: "We do not destroy the socket as we
 * can continue using the session"), and `keepAliveTimeout` is not consulted on
 * the H2 path at all, so a session whose flow has been black-holed while the TCP
 * connection stays established is never retired. Measured against a loopback h2
 * origin behind a TCP proxy that black-holes one flow: with `allowH2: true` one
 * request in eight kept failing indefinitely, while `allowH2: false` evicted the
 * socket on the first timeout and recovered on the next request. The kill switch
 * has to reach `allowH2` to get that behavior back.
 */
export const EVENTS_AGENT_OPTIONS_NO_H2 = {
  ...BASE_AGENT_OPTIONS,
  allowH2: false,
  pipelining: 1,
} as const;

/**
 * Options for the stream write/close Agents. Multiplexing is deliberately OFF:
 * one in-flight request per connection, so at most `connections` appends are
 * ever exposed to a single transport failure.
 *
 * Stream appends are not idempotent. Multiplexing N appends onto one connection
 * makes a single GOAWAY / socket reset fail all N at once, and
 * STREAM_RETRY_OPTIONS retries PUT on exactly those transient `errorCodes` — so
 * a connection-level blip would resend chunks the server may already have
 * applied and duplicate them. One request per connection keeps the failure
 * isolation that policy was written against.
 *
 * `pipelining: 1` alone no longer buys that on H2. It used to: undici's H2
 * `busy()` check reported the connection busy for any non-idempotent request, so
 * PUTs serialized regardless. undici 8 dropped that gate on purpose ("HTTP/2
 * multiplexes requests on independent streams, so non-idempotent requests can be
 * dispatched concurrently") and made the H2 in-flight ceiling the peer's
 * SETTINGS_MAX_CONCURRENT_STREAMS rather than `pipelining`. Measured against a
 * loopback H2 origin, 16 concurrent appends went from 1 to 16 in flight on one
 * connection. There is no client-side option that caps it back: the
 * `maxConcurrentStreams` option only seeds `peerMaxConcurrentStreams` and is
 * overwritten by the server's SETTINGS.
 *
 * So H2 is off here. These requests send a fully-buffered body or none, so H2 was
 * safe for them, but with multiplexing suppressed it was never doing anything the
 * H1 agent does not — the events agent is where H2 earns its place.
 */
export const STREAM_AGENT_OPTIONS = {
  ...BASE_AGENT_OPTIONS,
  allowH2: false,
  pipelining: 1,
} as const;

const RETRY_AGENT_OPTIONS: RetryHandler.RetryOptions = {
  // Observe Retry-After header if received
  retryAfter: true,
  // Retry 5xx in-process (genuine transient blips recover fast), but NOT 429.
  // The Vercel firewall issues a challenge as a 429: our server-to-server
  // client cannot solve a challenge, so in-process retries just re-trigger it
  // ~5× per request and amplify load against an already-overloaded firewall
  // during an incident. Letting 429 pass through surfaces it immediately to
  // makeRequest — which maps it to a ThrottleError carrying the
  // `x-vercel-mitigated` / `x-vercel-id` headers — and the queue does the
  // (backed-off) retry instead. This is the long-standing "let 429s pass
  // through" intent. (undici default is [500, 502, 503, 504, 429].)
  statusCodes: [500, 502, 503, 504],
};

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
 * Retry options for stream CLOSE (the `X-Stream-Done` PUT). Unlike chunk
 * appends, close is idempotent on the server: a duplicate close of a
 * completed stream early-returns, and the close-barrier protocol's durable
 * `closing` fence is an if_not_exists stamp that a re-entered close resumes
 * — so a 5xx whose effect may or may not have applied is safe to retry,
 * and the server's close barrier *relies* on it: a transient reconciliation
 * failure (or an unsafe close shape awaiting in-flight backups) is surfaced
 * as a retriable 503 with the stream left durably closing, expecting the
 * writer to close again. Without 5xx here, that 503 would reject
 * `writer.close()` outright and leave the stream fenced until run expiry.
 * 429 keeps the same pass-through-to-queue reasoning as chunk writes not
 * applying: close is one terminal request, so honoring Retry-After
 * in-process is the cleaner behavior. Exported so a test can pin the
 * close-is-retriable contract.
 */
export const STREAM_CLOSE_RETRY_OPTIONS: RetryHandler.RetryOptions = {
  retryAfter: true,
  methods: ['PUT'],
  statusCodes: [429, 500, 502, 503, 504],
};

/**
 * Largest body the H2 multiplexing interceptor will re-buffer. Event frames are
 * small CBOR payloads; the cap is a guard against an unexpectedly large write
 * being held in memory twice, not a tuning knob.
 */
const H2_REBUFFER_MAX_BYTES = 1 << 20; // 1 MiB

/**
 * Set `WORKFLOW_H2_MULTIPLEX=0` to take the events API off HTTP/2 entirely: no
 * multiplexing interceptor *and* `allowH2: false` (see
 * EVENTS_AGENT_OPTIONS_NO_H2 for why both are needed for this to be a usable
 * kill switch). Read when a dispatcher is built, so it applies to agents created
 * after it is set.
 */
function h2EventsEnabled(): boolean {
  return process.env.WORKFLOW_H2_MULTIPLEX !== '0';
}

function contentLength(headers: unknown): number {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return Number.NaN;
  }
  const record = headers as Record<string, unknown>;
  const raw = record['content-length'] ?? record['Content-Length'];
  return typeof raw === 'string' || typeof raw === 'number'
    ? Number(raw)
    : Number.NaN;
}

/**
 * Stand-in `DispatchController` for reporting an error that occurred before the
 * request was dispatched, so there is no controller undici created for it. Only
 * the error itself is consumed in that path (the v1 bridge rejects the awaiting
 * `fetch()` with it); the accessors exist to satisfy the interface.
 */
const NULL_DISPATCH_CONTROLLER: Dispatcher.DispatchController = {
  get aborted() {
    return false;
  },
  get paused() {
    return false;
  },
  get reason() {
    return null;
  },
  abort: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
};

/**
 * Undici interceptor that turns a streamed events-API request body back into a
 * Buffer before it is dispatched, so a retry can resend it.
 *
 * events-v4 hands us a fully materialized `Uint8Array`, but it dispatches
 * through the global `fetch` (deliberately — that is what keeps v4 traffic
 * visible in Vercel's outgoing-requests view, see events-v4.ts), and `fetch`
 * converts every body into an async iterable on the way down. An async iterable
 * can only be consumed once, so when RetryAgent re-dispatches on a 5xx the body
 * is already exhausted: measured against a loopback H2 origin, the retry aborts
 * the request with `NGHTTP2_PROTOCOL_ERROR` instead of resending. Draining the
 * body into a Buffer first costs one copy of an already-in-memory payload and
 * makes the retry byte-identical. Bodies without a usable `content-length`, or
 * above H2_REBUFFER_MAX_BYTES, are passed through untouched rather than buffered
 * blind.
 *
 * This used to also be what made the events path multiplex, by marking requests
 * `idempotent` so undici's H2 `busy()` gate would not serialize them behind each
 * other. undici 8 dispatches non-idempotent requests (nodejs/undici#5391) and
 * stream-bodied requests (nodejs/undici#5538) concurrently on its own, so that
 * part is gone and requests are no longer relabelled.
 */
export function bufferStreamedBodyInterceptor(
  dispatch: Dispatcher['dispatch']
): Dispatcher['dispatch'] {
  return (opts, handler) => {
    const body = opts.body;
    const isAsyncIterable =
      !!body &&
      typeof body !== 'string' &&
      !Buffer.isBuffer(body) &&
      typeof (body as unknown as Record<symbol, unknown>)[
        Symbol.asyncIterator
      ] === 'function';
    const length = contentLength(opts.headers);

    if (!isAsyncIterable || !(length >= 0) || length > H2_REBUFFER_MAX_BYTES) {
      return dispatch(opts, handler);
    }

    // Drain asynchronously, then dispatch. Returning `true` reports "no
    // backpressure", which is accurate: the request is accepted, and the drain
    // is bounded by H2_REBUFFER_MAX_BYTES.
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        dispatch({ ...opts, body: Buffer.concat(chunks) }, handler);
      } catch (error) {
        // Surface a drain failure the way undici would have surfaced a body
        // error, so the awaiting fetch() rejects instead of hanging.
        //
        // `onResponseError` is the v2 handler callback. undici 8 removed the
        // legacy handler wrappers, and because the composed dispatcher is
        // wrapped in `Dispatcher1Wrapper` (see forGlobalFetch) that bridge sits
        // *outside* this interceptor — so the handler arriving here is always v2
        // and the v7-era `onError` no longer exists on it. Calling the old name
        // would be a silent no-op and hang the awaiting fetch() forever.
        //
        // The failure happened before anything was dispatched, so there is no
        // real controller to hand over; a never-aborted stub satisfies the
        // signature without pretending the request reached the wire.
        handler.onResponseError?.(NULL_DISPATCH_CONTROLLER, error as Error);
      }
    })();
    return true;
  };
}

/**
 * Consecutive transport failures on the *same* shared dispatcher before it is
 * retired and rebuilt.
 *
 * The count is what separates a fault undici recovers from on its own from one it
 * does not. On HTTP/1.1, and on H2 for connection-level events (GOAWAY, socket
 * reset), undici destroys the connection as part of failing the request, so the
 * next request opens a fresh one and a single failure is the whole story. The
 * case this exists for is the one where it doesn't: an H2 stream timeout leaves
 * the session in place by design, so if the flow underneath it has been
 * black-holed while TCP stays established, every later request routed onto that
 * session times out too — indefinitely. Requiring several failures in a row means
 * the self-healing paths never trigger a rebuild, and the wedged-session path
 * always does.
 */
export const EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES = 3;

/**
 * Floor on how often a recycler will rebuild, so a persistently unreachable
 * origin can't turn every few requests into a fresh TLS handshake.
 */
const RECYCLE_MIN_INTERVAL_MS = 5_000;

/**
 * How long a retired dispatcher is left dispatchable before it is closed.
 *
 * A request that resolved the dispatcher just before the swap has not dispatched
 * yet, and `close()` would reject it with ClientClosedError — turning a healthy
 * event write into a step retry. The delay makes that race impossible in
 * practice; the retired agent serves those few requests and then closes.
 */
const RETIRED_CLOSE_DELAY_MS = 5_000;

/**
 * Backstop for `close()` never settling. Closing is graceful: it waits for
 * in-flight requests, which on a black-holed session means waiting for each
 * stream's own timeout. Anything still in flight this long after retirement is
 * wedged by definition, so the sockets get freed the hard way.
 */
const RETIRED_DESTROY_DELAY_MS = 60_000;

/**
 * undici error codes that mean "no response arrived over a connection that was
 * already established". These are the failures a rebuild can fix; DNS, connect
 * and TLS errors are excluded because a new agent would hit the same wall, and an
 * abort is excluded because it is the caller's own doing.
 */
const RECYCLABLE_ERROR_CODES = new Set([
  // Covers H2 stream timeout, frameError and GOAWAY (undici InformationalError).
  'UND_ERR_INFO',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Guard against a self-referential `cause` chain. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when `error` (or anything in its `cause` chain) is a transport failure a
 * dispatcher rebuild can fix. The chain walk is required, not defensive: `fetch`
 * rejects with `TypeError: fetch failed` and hangs the undici error off `cause`,
 * so the code is never on the error the caller sees. Exported for tests.
 */
export function isRecyclableTransportError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && RECYCLABLE_ERROR_CODES.has(code)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface DispatcherRecycler {
  /** The current shared dispatcher, built on first use. */
  get(): RetryAgent;
  /**
   * Record the transport-level outcome of one request: `error` when the
   * `fetch()`/dispatch itself failed, nothing when a response arrived (whatever
   * its status — an HTTP error is the origin answering, so the transport worked).
   *
   * `dispatcher` is the dispatcher the request actually used. Outcomes from any
   * other dispatcher are ignored, which covers both a caller-supplied override
   * and the tail of the batch that provoked a rebuild: those requests were issued
   * on the now-retired agent, and counting them would immediately recycle its
   * replacement too.
   */
  note(dispatcher: unknown, error?: unknown): void;
}

/**
 * Wraps a dispatcher factory with the failure accounting that retires a wedged
 * connection pool. Exported so a test can drive the whole loop against a
 * loopback origin; production uses the events recycler below.
 */
export function createDispatcherRecycler(
  factory: () => RetryAgent,
  label: string
): DispatcherRecycler {
  let current: RetryAgent | undefined;
  let consecutiveFailures = 0;
  let lastRecycledAt = 0;

  function retire(stale: RetryAgent): void {
    const closeTimer = setTimeout(() => {
      void Promise.resolve(stale.close?.()).catch(() => undefined);
    }, RETIRED_CLOSE_DELAY_MS);
    const destroyTimer = setTimeout(() => {
      void Promise.resolve(stale.destroy?.()).catch(() => undefined);
    }, RETIRED_DESTROY_DELAY_MS);
    // Never hold the process open for a pool we have already given up on.
    closeTimer.unref?.();
    destroyTimer.unref?.();
  }

  return {
    get(): RetryAgent {
      current ??= factory();
      return current;
    },

    note(dispatcher: unknown, error?: unknown): void {
      if (!current || dispatcher !== current) return;
      if (error === undefined) {
        consecutiveFailures = 0;
        return;
      }
      if (!isRecyclableTransportError(error)) return;
      consecutiveFailures++;
      if (consecutiveFailures < EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES) {
        return;
      }
      const now = Date.now();
      if (now - lastRecycledAt < RECYCLE_MIN_INTERVAL_MS) return;
      lastRecycledAt = now;
      consecutiveFailures = 0;
      const stale = current;
      // Swap first: subsequent requests build and use a fresh pool, and the
      // stale agent stops receiving `note` calls.
      current = undefined;
      // Breadcrumb on stderr (stdout is a machine-parsed contract in the CLI):
      // a rebuild means the transport was stuck, which is worth seeing in
      // function logs even though the SDK recovered on its own.
      console.warn(
        `[workflow] ${label}: rebuilding connection pool after ${EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES} consecutive transport failures`
      );
      retire(stale);
    },
  };
}

/**
 * The shared events dispatcher, with the failure accounting that makes a
 * black-holed HTTP/2 session self-healing. See createDispatcherRecycler and
 * EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES.
 */
const eventsRecycler = createDispatcherRecycler(
  () => createEventsDispatcher(),
  'events transport'
);

/**
 * Record the transport-level outcome of a v4 events request so a wedged
 * connection pool gets retired. No-ops for a caller-supplied dispatcher. Called
 * by `fetchV4`; see DispatcherRecycler.note.
 */
export function noteEventsTransportOutcome(
  dispatcher: unknown,
  error?: unknown
): void {
  eventsRecycler.note(dispatcher, error);
}

/**
 * Resolves the undici dispatcher for a request: the caller's override, or the
 * shared default agent (HTTP/1.1).
 */
export function getDispatcher(config?: APIConfig): unknown {
  if (config?.dispatcher != null)
    return bridgeCallerDispatcher(config.dispatcher);
  return getDefaultDispatcher();
}

/**
 * Resolves the dispatcher for the v4 events API: the caller's override, or the
 * shared HTTP/2 events agent. See EVENTS_AGENT_OPTIONS for why the events API
 * uses H2 while the default path stays on H1.
 *
 * The shared agent is not a fixed instance for the life of the process: repeated
 * transport failures retire it and the next call here builds a replacement (see
 * noteEventsTransportOutcome). Resolve it per request rather than caching the
 * returned value.
 */
export function getEventsDispatcher(config?: APIConfig): unknown {
  if (config?.dispatcher != null)
    return bridgeCallerDispatcher(config.dispatcher);
  return eventsRecycler.get();
}

/**
 * Resolves the dispatcher for stream writes (the PUT write/close path): the
 * caller's override, or the shared HTTP/2 stream agent. See
 * getDefaultStreamDispatcher (and STREAM_RETRY_OPTIONS) for its deliberately
 * narrowed retry policy — transient connection errors + HTTP 429 only, never
 * 5xx — chosen because stream appends are not idempotent.
 */
export function getStreamDispatcher(config?: APIConfig): unknown {
  if (config?.dispatcher != null)
    return bridgeCallerDispatcher(config.dispatcher);
  return getDefaultStreamDispatcher();
}

/**
 * Resolves the dispatcher for stream CLOSE: the caller's override, or the
 * shared close agent whose retry policy includes 5xx — close is idempotent
 * (see STREAM_CLOSE_RETRY_OPTIONS), unlike chunk appends.
 */
export function getStreamCloseDispatcher(config?: APIConfig): unknown {
  if (config?.dispatcher != null)
    return bridgeCallerDispatcher(config.dispatcher);
  return getDefaultStreamCloseDispatcher();
}

/**
 * Makes a dispatcher usable as the `dispatcher` option of the *global* `fetch`.
 *
 * Every request in this package goes through global `fetch` (see `makeRequest`
 * in http-core.ts, and `fetchV4` in events-v4.ts — v4 does so deliberately, to
 * stay visible in Vercel's outgoing-requests view). That `fetch` belongs to the
 * undici bundled into Node, not to the undici in our dependencies, and it drives
 * a custom dispatcher with a *v1* handler (`onConnect`/`onHeaders`/`onData`/
 * `onComplete`/`onError`).
 *
 * undici 8 removed the legacy handler wrappers that used to accept such a
 * handler, and the two failure modes are both silent-to-severe:
 *  - a bare `Agent` rejects the request with `TypeError: fetch failed`, cause
 *    `invalid onRequestStart method`;
 *  - a `RetryAgent` (or a composed dispatcher) never calls any callback the v1
 *    handler implements, so `fetch()` simply *never settles* — every request
 *    hangs until the caller's own timeout.
 *
 * `bridgeV1Handler` translates the v1 handler into the v2 callbacks the v8
 * dispatcher emits. It must be the outermost layer, which is why it is applied
 * here rather than inside `compose()`.
 *
 * undici ships its own bridge for this, `Dispatcher1Wrapper`, and it cannot be
 * used on an H2 path. It forwards `controller.rawHeaders` to `onHeaders`, which
 * the H1 parser sets to the raw `Buffer[]` a v1 handler expects, but which
 * `client-h2.js` sets to a plain `{ name: value }` object. That object has no
 * `.length`, so the pair-wise loop in `fetch`'s v1 handler reads zero headers and
 * the response arrives with an empty `Headers` and the right status and body.
 * Measured against a loopback H2 origin: `content-type` and every other response
 * header disappear. undici's wrapper compensates by forcing `allowH2: false` onto
 * every request (a v1 handler also cannot carry a WebSocket upgrade over H2,
 * nodejs/undici#4989), and the Agent honours that per request by routing to a
 * separate `${origin}#http1-only` pool. Accepting that would downgrade the events
 * path to HTTP/1.1 and undo the multiplexing and flow-control work these agents
 * exist for, with ALPN negotiating `http/1.1` while every option here still said
 * H2. The bridge below instead normalizes the header shape and leaves `allowH2`
 * alone. That is safe for these dispatchers specifically: they only ever carry
 * plain request/response traffic, and the WebSocket transport (events-v4-ws.ts)
 * does not run through them.
 *
 * Wrapping is done once per dispatcher, at construction, because
 * `DispatcherRecycler.note()` identifies the dispatcher a request used by
 * reference — a wrapper minted per request would never match.
 *
 * `interceptors` are composed underneath the bridge, so they observe the v2
 * handler the bridge produces. The composed dispatcher goes through
 * `withBoundLifecycle` because `compose()` returns a Proxy whose `close()` is
 * broken, and the bridge forwards `close()`/`destroy()` straight through to
 * whatever it wraps.
 */
function forGlobalFetch(
  dispatcher: RetryAgent,
  ...interceptors: Array<Dispatcher.DispatcherComposeInterceptor>
): RetryAgent {
  const composed = dispatcher.compose(...interceptors) as unknown as RetryAgent;
  return bridgeV1Handler(withBoundLifecycle(dispatcher, composed));
}

interface V1Handler {
  onConnect?: (abort: (reason?: Error) => void, context?: unknown) => void;
  onHeaders?: (
    statusCode: number,
    rawHeaders: unknown,
    resume: () => void,
    statusText?: string
  ) => boolean | void;
  onData?: (chunk: Buffer) => boolean | void;
  onComplete?: (rawTrailers: unknown) => void;
  onError?: (error: Error) => void;
  onUpgrade?: (
    statusCode: number,
    rawHeaders: unknown,
    socket: unknown
  ) => void;
  onBodySent?: (chunk: unknown) => void;
  onRequestSent?: () => void;
  onResponseStarted?: () => void;
}

/**
 * The `Buffer[]` pair list a v1 handler parses headers out of. Mirrors undici's
 * internal `toRawHeaders`, which is not exported.
 */
function toRawHeaders(headers: Record<string, string | string[]>): Buffer[] {
  const raw: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      raw.push(Buffer.from(name, 'latin1'), Buffer.from(`${entry}`, 'latin1'));
    }
  }
  return raw;
}

/**
 * Header list for a v1 handler, whichever shape the dispatcher produced: the H1
 * parser exposes the raw `Buffer[]` on the controller, while H2 has only the
 * parsed object passed as the callback argument. `field` selects which of the
 * controller's two lists applies, since headers and trailers each have their own
 * and the response headers stay on the controller after the body ends.
 */
function rawHeadersFor(
  controller: unknown,
  parsed: unknown,
  field: 'rawHeaders' | 'rawTrailers' = 'rawHeaders'
): unknown {
  const fromController = (controller as Record<string, unknown> | undefined)?.[
    field
  ];
  if (Array.isArray(fromController)) return fromController;
  return toRawHeaders((parsed ?? {}) as Record<string, string | string[]>);
}

const V1_CALLBACKS = [
  'onConnect',
  'onHeaders',
  'onData',
  'onComplete',
  'onError',
  'onUpgrade',
] as const;

/**
 * Adapts a v1 handler to the v2 callbacks an undici 8 dispatcher emits, while
 * keeping the v1 callbacks on the same object.
 *
 * `APIConfig.dispatcher` accepts an instance from any undici version, and undici
 * 6 knows only the v1 ABI: it validates the handler on dispatch and rejects a
 * pure v2 one with `invalid onError method`. Measured across 6, 7 and 8, a
 * handler carrying both ABIs is driven through exactly one of them and never
 * both: 6 calls only the v1 callbacks, 7 and 8 only the v2 ones.
 *
 * The v1 callbacks are copied rather than defined unconditionally so that undici
 * 6 still sees a handler missing a required callback as missing it.
 */
function wrapV1Handler(handler: V1Handler): Dispatcher.DispatchHandler {
  const passthrough: Record<string, unknown> = {};
  for (const name of V1_CALLBACKS) {
    const callback = handler[name];
    if (typeof callback === 'function') {
      passthrough[name] = callback.bind(handler);
    }
  }
  return {
    ...passthrough,
    onRequestStart(controller, context) {
      // `abort()` types its reason as required, but undici defaults an
      // undefined one to RequestAbortedError. Passing it through keeps the
      // error identity a v1 caller expects.
      handler.onConnect?.(
        (reason?: Error) => controller.abort(reason as Error),
        context
      );
    },
    onRequestUpgrade(controller, statusCode, headers, socket) {
      handler.onUpgrade?.(
        statusCode,
        rawHeadersFor(controller, headers),
        socket
      );
    },
    onResponseStart(controller, statusCode, headers, statusMessage) {
      const proceed = handler.onHeaders?.(
        statusCode,
        rawHeadersFor(controller, headers),
        () => controller.resume(),
        statusMessage
      );
      if (proceed === false) controller.pause();
    },
    onResponseData(controller, chunk) {
      if (handler.onData?.(chunk) === false) controller.pause();
    },
    onResponseEnd(controller, trailers) {
      handler.onComplete?.(rawHeadersFor(controller, trailers, 'rawTrailers'));
    },
    onResponseError(_controller, error) {
      if (!handler.onError) throw error;
      handler.onError(error);
    },
    onBodySent(chunk) {
      handler.onBodySent?.(chunk);
    },
    onRequestSent() {
      handler.onRequestSent?.();
    },
    onResponseStarted() {
      handler.onResponseStarted?.();
    },
  } as Dispatcher.DispatchHandler;
}

/**
 * A dispatcher that accepts a v1 handler, passing a v2 one straight through (a
 * future Node whose bundled `fetch` drives v2 handlers needs no bridging).
 */
class V1BridgeDispatcher extends Dispatcher {
  readonly #inner: Dispatcher;

  constructor(inner: Dispatcher) {
    super();
    this.#inner = inner;
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: V1Handler): boolean {
    return this.#inner.dispatch(
      opts,
      typeof (handler as Dispatcher.DispatchHandler).onRequestStart ===
        'function'
        ? (handler as Dispatcher.DispatchHandler)
        : wrapV1Handler(handler)
    );
  }

  close(...args: unknown[]): Promise<void> {
    return (this.#inner.close as (...a: unknown[]) => Promise<void>).apply(
      this.#inner,
      args
    );
  }

  destroy(...args: unknown[]): Promise<void> {
    return (this.#inner.destroy as (...a: unknown[]) => Promise<void>).apply(
      this.#inner,
      args
    );
  }
}

function bridgeV1Handler<T>(dispatcher: T): T {
  return new V1BridgeDispatcher(dispatcher as Dispatcher) as unknown as T;
}

/**
 * Same bridge as `forGlobalFetch`, for a dispatcher supplied by the caller
 * through `APIConfig.dispatcher`.
 *
 * That option is documented as accepting a dispatcher from any undici version.
 * A v8 one handed straight to global `fetch` hangs forever (see
 * `forGlobalFetch`), and undici 8 is now what a caller who installs `undici`
 * alongside this package gets, so the bridge has to be applied here too. It is
 * safe for older dispatchers as well: undici 6/7 dispatchers accept the v2
 * handler the bridge produces.
 *
 * Memoized because the recycler and the retry bookkeeping compare dispatchers by
 * reference, and a caller may pass the same instance to many calls.
 */
const bridgedCallerDispatchers = new WeakMap<object, unknown>();

function bridgeCallerDispatcher(dispatcher: unknown): unknown {
  if (
    dispatcher == null ||
    typeof dispatcher !== 'object' ||
    dispatcher instanceof V1BridgeDispatcher
  ) {
    return dispatcher;
  }
  const cached = bridgedCallerDispatchers.get(dispatcher);
  if (cached !== undefined) return cached;

  const bridged = bridgeV1Handler(dispatcher as Dispatcher);
  bridgedCallerDispatchers.set(dispatcher, bridged);
  return bridged;
}

/** Build a shared undici RetryAgent wrapping an Agent with the given options. */
function makeRetryDispatcher(
  agentOptions: typeof DEFAULT_AGENT_OPTIONS,
  retryOptions: RetryHandler.RetryOptions
): RetryAgent {
  return forGlobalFetch(new RetryAgent(new Agent(agentOptions), retryOptions));
}

/**
 * Builds the events-API dispatcher: the H2 agent plus the interceptor that makes
 * H2 actually multiplex. Exported (rather than only reachable through the
 * `getEventsDispatcher` singleton) so a test can exercise this exact wiring
 * against a loopback server via `agentOverrides` — asserting on
 * EVENTS_AGENT_OPTIONS alone cannot catch the composition being dropped.
 */
export function createEventsDispatcher(
  agentOverrides?: Partial<Agent.Options>
): RetryAgent {
  const h2 = h2EventsEnabled();
  const agent = new RetryAgent(
    new Agent({
      ...(h2 ? EVENTS_AGENT_OPTIONS : EVENTS_AGENT_OPTIONS_NO_H2),
      ...agentOverrides,
    }),
    RETRY_AGENT_OPTIONS
  );
  if (!h2) {
    return forGlobalFetch(agent);
  }
  // The interceptor wraps the RetryAgent (rather than the Agent inside it) so
  // that retries re-send the *drained* body. RetryHandler captures its own copy
  // of the request body up front — `wrapRequestBody` (undici core/util.js) hands
  // an async-iterable body to a fresh `BodyAsyncIterable`. Composed inside, that
  // copy would wrap the stream the interceptor is about to consume, so a retry
  // would re-iterate an exhausted stream and send an empty body. Composed
  // outside, RetryHandler captures the Buffer and replays it verbatim.
  return forGlobalFetch(agent, bufferStreamedBodyInterceptor);
}

/**
 * Restores `close()`/`destroy()` on a composed dispatcher.
 *
 * `Dispatcher.compose()` returns `new Proxy(this, { get: (t, k) => k ===
 * 'dispatch' ? composed : t[k] })`, so every other method comes back unbound and
 * runs with the Proxy as `this`. For a RetryAgent that means `close()` throws
 * `TypeError: Cannot read private member #agent from an object whose class did
 * not declare it`. Binding the lifecycle methods to the real instance keeps the
 * composed dispatcher disposable.
 */
function withBoundLifecycle(
  agent: RetryAgent,
  composed: RetryAgent
): RetryAgent {
  return new Proxy(composed, {
    get: (target, key) =>
      key === 'close' || key === 'destroy'
        ? (agent[key] as (...args: unknown[]) => unknown).bind(agent)
        : target[key as keyof RetryAgent],
  });
}

/**
 * Builds a stream write/close dispatcher. Exported for the same reason as
 * `createEventsDispatcher` — so a test can assert the inverse property, that
 * these deliberately do NOT multiplex.
 */
export function createStreamDispatcher(
  retryOptions: RetryHandler.RetryOptions,
  agentOverrides?: Partial<Agent.Options>
): RetryAgent {
  return forGlobalFetch(
    new RetryAgent(
      new Agent({ ...STREAM_AGENT_OPTIONS, ...agentOverrides }),
      retryOptions
    )
  );
}

/**
 * Returns the shared default RetryAgent.
 *
 * - HTTP/1.1 (see DEFAULT_AGENT_OPTIONS)
 * - Connection pooling (up to 8 connections per origin)
 * - Retry: Automatic retry on 5xx or network errors with exponential backoff
 *   (idempotent methods only — undici's default never retries POST), observing
 *   the `Retry-After` header when present.
 */
function getDefaultDispatcher(): RetryAgent {
  _dispatcher ??= makeRetryDispatcher(
    DEFAULT_AGENT_OPTIONS,
    RETRY_AGENT_OPTIONS
  );
  return _dispatcher;
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
 * issues that keep the long-lived live-read on plain `fetch`) via
 * STREAM_AGENT_OPTIONS — which, unlike the events agent, keeps multiplexing off
 * so one connection-level failure cannot fail (and thus retry) several appends
 * at once.
 */
function getDefaultStreamDispatcher(): RetryAgent {
  _streamDispatcher ??= createStreamDispatcher(STREAM_RETRY_OPTIONS);
  return _streamDispatcher;
}

/** Shared agent for the idempotent stream close (5xx retriable). */
function getDefaultStreamCloseDispatcher(): RetryAgent {
  _streamCloseDispatcher ??= createStreamDispatcher(STREAM_CLOSE_RETRY_OPTIONS);
  return _streamCloseDispatcher;
}
