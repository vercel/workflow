import { Agent, type Dispatcher, RetryAgent, type RetryHandler } from 'undici';
import type { APIConfig } from './utils.js';

let _dispatcher: RetryAgent | undefined;
let _eventsDispatcher: RetryAgent | undefined;
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
 * In-flight H2 streams allowed per connection. Matches undici's
 * `maxConcurrentStreams` default (100), which is the real ceiling once the
 * server's SETTINGS_MAX_CONCURRENT_STREAMS is known — so this only has to be
 * large enough not to be the binding constraint. The Vercel edge advertises
 * SETTINGS_MAX_CONCURRENT_STREAMS 160, so it isn't.
 *
 * Note that undici's `maxConcurrentStreams` *option* is not this gate: it only
 * seeds `peerMaxConcurrentStreams` at connect time and is then overwritten by
 * the server's SETTINGS. Raising it is inert — measured at ±1.6% (inside a 6.1%
 * noise floor) across every workload shape. `pipelining` is the only knob that
 * actually gates in-flight streams; see EVENTS_AGENT_OPTIONS.
 */
const H2_MAX_IN_FLIGHT_STREAMS = 100;

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
 * `pipelining` must be set for H2 to multiplex at all. undici gates in-flight
 * requests per connection on `getPipelining(client)`, which reads
 * `client[kPipelining] ?? httpContext.defaultPipelining ?? 1`. `client-h2.js`
 * sets `defaultPipelining: Infinity`, but the Client constructor coerces
 * `pipelining` to a number (`pipelining != null ? pipelining : 1`), so
 * `kPipelining` is never nullish and H2's Infinity is unreachable — leaving one
 * in-flight stream per connection. Before this was set, the H2 agent behaved
 * byte-for-byte like the H1 agent: 16 concurrent requests produced 8 in-flight
 * requests over 8 TCP connections. See nodejs/undici#4143.
 *
 * Multiplexing interacts with flow control, which is why the receive windows are
 * raised here too. Concentrating N streams onto one connection makes them share
 * that connection's single receive window, so the download side gets *worse* as
 * multiplexing improves unless the window grows with it: at 32 concurrent reads,
 * `pipelining: 1` measured 70% faster than `pipelining: 100` on downloads purely
 * because spreading streams over 8 connections gave them 8 separate windows.
 * Raising the windows removes that trade-off — the multiplexed agent then beats
 * both.
 */
export const EVENTS_AGENT_OPTIONS = {
  ...BASE_AGENT_OPTIONS,
  allowH2: true,
  pipelining: H2_MAX_IN_FLIGHT_STREAMS,
  initialWindowSize: H2_STREAM_WINDOW_BYTES,
  connectionWindowSize: H2_CONNECTION_WINDOW_BYTES,
} as const;

/**
 * Options for the stream write/close Agents. H2 is enabled (these send a
 * fully-buffered body, or none, so they avoid the duplex-streaming issues that
 * keep the long-lived live-read on plain `fetch`), but multiplexing is
 * deliberately left OFF — `pipelining: 1`, one in-flight request per
 * connection.
 *
 * Stream appends are not idempotent. Multiplexing N appends onto one connection
 * makes a single RST_STREAM / GOAWAY / socket reset fail all N at once, and
 * STREAM_RETRY_OPTIONS retries PUT on exactly those transient `errorCodes` — so
 * a connection-level blip would resend chunks the server may already have
 * applied and duplicate them. Serializing keeps the existing
 * one-request-per-connection failure isolation that policy was written against.
 *
 * Note this is currently belt-and-braces: undici's H2 `busy()` check already
 * serializes non-idempotent requests (`client-h2.js`: `if
 * (request.idempotent === false) return true`), so PUTs would not multiplex even
 * at a higher pipelining value. Setting it explicitly means the safety property
 * does not silently depend on that upstream detail.
 */
export const STREAM_AGENT_OPTIONS = {
  ...BASE_AGENT_OPTIONS,
  allowH2: true,
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

/** Set `WORKFLOW_H2_MULTIPLEX=0` to fall back to one request per connection. */
function h2MultiplexEnabled(): boolean {
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
 * Undici interceptor that lets the events API actually multiplex over H2.
 *
 * `pipelining` (see EVENTS_AGENT_OPTIONS) is necessary but not sufficient:
 * undici's H2 `busy()` check reports the connection busy — serializing the
 * request behind whatever is in flight — for two more reasons, both of which
 * every events request trips.
 *
 * 1. Non-idempotent method. `client-h2.js` returns busy when
 *    `request.idempotent === false`, and undici only treats GET/HEAD as
 *    idempotent by default (`core/request.js`), so every event-write POST
 *    serializes. We mark them idempotent for *concurrency* purposes only: in
 *    undici 7 the flag feeds nothing but the H1/H2 `busy()` gates — it does not
 *    cause resends. Retries are governed solely by RetryAgent, whose
 *    `methods` default (`['GET','HEAD','OPTIONS','PUT','DELETE','TRACE']`)
 *    excludes POST, so an event write is still never replayed. See
 *    nodejs/undici#5390.
 *
 * 2. Streamed request body. `client-h2.js` also returns busy for a body that is
 *    a stream / async iterable, because such a body can error mid-flight and
 *    take unrelated in-flight requests down with it. events-v4 hands us a fully
 *    materialized `Uint8Array`, but it dispatches through the global `fetch`
 *    (deliberately — that is what keeps v4 traffic visible in Vercel's outgoing
 *    -requests view, see events-v4.ts), and `fetch` converts every body into an
 *    async iterable on the way down. Draining it back into a Buffer restores the
 *    buffered-body shape undici needs, at the cost of one copy of an
 *    already-in-memory payload. Bodies without a usable `content-length`, or
 *    above H2_REBUFFER_MAX_BYTES, are passed through untouched (and stay
 *    serialized) rather than buffered blind.
 *
 * Without both of these, `pipelining` alone leaves the events agent at one
 * in-flight request per connection.
 */
export function h2MultiplexInterceptor(
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
      return dispatch({ ...opts, idempotent: true }, handler);
    }

    // Drain asynchronously, then dispatch. Returning `true` reports "no
    // backpressure", which is accurate: the request is accepted, and the pool
    // gate we are lifting is exactly the one that would have reported drain.
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        dispatch(
          { ...opts, body: Buffer.concat(chunks), idempotent: true },
          handler
        );
      } catch (error) {
        // Surface a drain failure the way undici would have surfaced a body
        // error, so the awaiting fetch() rejects instead of hanging.
        handler.onError?.(error as Error);
      }
    })();
    return true;
  };
}

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
 * Resolves the dispatcher for stream CLOSE: the caller's override, or the
 * shared close agent whose retry policy includes 5xx — close is idempotent
 * (see STREAM_CLOSE_RETRY_OPTIONS), unlike chunk appends.
 */
export function getStreamCloseDispatcher(config?: APIConfig): unknown {
  return config?.dispatcher ?? getDefaultStreamCloseDispatcher();
}

/** Build a shared undici RetryAgent wrapping an Agent with the given options. */
function makeRetryDispatcher(
  agentOptions: typeof DEFAULT_AGENT_OPTIONS,
  retryOptions: RetryHandler.RetryOptions
): RetryAgent {
  return new RetryAgent(new Agent(agentOptions), retryOptions);
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
  const agent = new RetryAgent(
    new Agent({ ...EVENTS_AGENT_OPTIONS, ...agentOverrides }),
    RETRY_AGENT_OPTIONS
  );
  if (!h2MultiplexEnabled()) {
    return agent;
  }
  // The interceptor wraps the RetryAgent (rather than the Agent inside it) so
  // that retries re-send the *drained* body. RetryHandler captures its own copy
  // of the request body up front — `wrapRequestBody` (undici core/util.js) hands
  // an async-iterable body to a fresh `BodyAsyncIterable`. Composed inside, that
  // copy would wrap the stream the interceptor is about to consume, so a retry
  // would re-iterate an exhausted stream and send an empty body. Composed
  // outside, RetryHandler captures the Buffer and replays it verbatim.
  return withBoundLifecycle(
    agent,
    agent.compose(h2MultiplexInterceptor) as unknown as RetryAgent
  );
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
  return new RetryAgent(
    new Agent({ ...STREAM_AGENT_OPTIONS, ...agentOverrides }),
    retryOptions
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
 * Returns the shared HTTP/2 RetryAgent used by the v4 events API. Same retry /
 * pooling behavior as the default dispatcher, but with `allowH2` enabled, a
 * pipelining depth that lets H2 actually multiplex (EVENTS_AGENT_OPTIONS), and
 * the interceptor that lifts undici's remaining two per-request H2 busy gates
 * (h2MultiplexInterceptor).
 */
function getDefaultEventsDispatcher(): RetryAgent {
  _eventsDispatcher ??= createEventsDispatcher();
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
