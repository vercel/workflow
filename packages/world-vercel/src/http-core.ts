/**
 * Shared HTTP request core for the world-vercel adapter.
 *
 * Every outgoing request from world-vercel goes through one of a few
 * higher-level clients: the v3 `makeRequest`, the v4 events client, the
 * streamer, and the direct Vercel-API calls (run-key / resolve-deployment).
 * They differ in how they shape the *body* (CBOR + schema, binary frames, raw
 * chunks, JSON), but they share the same cross-cutting envelope: an OTEL client
 * span, trace-context injection, a cache-bust header, a request timeout,
 * `DEBUG` logging, x-vercel diagnostic headers, and the status → typed-error
 * mapping the runtime branches on.
 *
 * This module is the single source of truth for that envelope. Undici
 * dispatchers are passed in by the caller rather than resolved here, so it can
 * be imported by both `utils.ts` and `events-v4.ts` without an import cycle.
 * The one thing it does reach for is `http-client.js`'s shared node:http pool,
 * which is safe: `http-client.ts` imports nothing from `utils.ts` but a type.
 */

import type { Attributes, Span } from '@opentelemetry/api';
import { getVercelOidcToken } from '@vercel/oidc';
import {
  EntityConflictError,
  PreconditionFailedError,
  RunExpiredError,
  StreamError,
  StreamExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { envNumber } from '@workflow/world';
import { nodeHttpFetch } from '@workflow/world/node-http.js';
import {
  getNodeHttpAgents,
  NODE_HTTP_BODY_TIMEOUT_MS,
  NODE_HTTP_HEADERS_TIMEOUT_MS,
} from './http-client.js';
import {
  ErrorType,
  getSpanKind,
  HttpRequestMethod,
  HttpResponseStatusCode,
  injectTraceContextIntoHeaders,
  PeerService,
  RpcService,
  RpcSystem,
  ServerAddress,
  ServerPort,
  trace,
  UrlFull,
  WorkflowHttpTransport,
} from './telemetry.js';

/**
 * Per-request timeout for HTTP calls to workflow-server (in ms).
 *
 * Without this, a hung workflow-server response would keep the caller blocked
 * until the platform's `maxDuration` SIGTERM, burning compute and defeating
 * upstream timeout handlers (e.g. the replay timeout).
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Transport codes that can surface after `fetch()` fails before returning a
 * response. The outer error is usually `TypeError: fetch failed`; undici hangs
 * the actionable code off its `cause`, so callers must inspect the chain.
 */
const TRANSIENT_TRANSPORT_ERROR_CODES = new Set([
  'UND_ERR_INFO',
  'UND_ERR_REQ_RETRY',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
]);

export function getTransientTransportCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_TRANSPORT_ERROR_CODES.has(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Reject invalid URLs before dispatch, where a failure would be retryable. */
export function validateHttpUrl(url: string): void {
  const { protocol, username, password } = new URL(url);
  // Both fetch and nodeHttpFetch can reject unsupported schemes without an
  // error code, so describeTransportFailure cannot identify these faults.
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new TypeError(
      `Unsupported URL protocol ${protocol}; expected http: or https:`
    );
  }
  // Fetch rejects URL userinfo locally with a code-less TypeError. Keep that
  // permanent configuration fault outside the transport classifier, and make
  // the node:http and Fetch paths agree instead of allowing one to send it.
  if (username || password) {
    throw new TypeError(
      'HTTP(S) URLs with embedded credentials are unsupported'
    );
  }
}

/**
 * Codes that mean the request was never *formed*, as opposed to formed and
 * then failed on the wire. `fetch()` reports a malformed URL, an invalid
 * header name/value, or a bad argument as a rejected `TypeError` that is
 * structurally identical to the `TypeError: fetch failed` it raises for a dead
 * socket, and the node:http path throws Node's own `ERR_*`.
 *
 * These faults are permanent — every redelivery re-forms the same broken
 * request — so they must keep propagating raw rather than being classified as
 * a retryable transport failure, which would spend the run's whole delivery
 * budget before failing it with a less specific error than it started with.
 */
const REQUEST_CONSTRUCTION_ERROR_CODES = new Set([
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_CHAR',
  'ERR_INVALID_HTTP_TOKEN',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_UNESCAPED_CHARACTERS',
  // Undici validates request options and headers during dispatch, after
  // Fetch has constructed the Request (e.g. unsupported Expect headers).
  'UND_ERR_INVALID_ARG',
  'UND_ERR_NOT_SUPPORTED',
]);

/**
 * Classify a rejection from `fetch()` / `nodeHttpFetch()`, calls that only
 * settle once the response headers are in hand.
 *
 * A rejection leaves the request outcome unknown: it may have failed locally,
 * or the backend may have applied it without a response reaching the caller.
 * Preserve known request-construction faults; route other failures through
 * the existing retry policies instead of attributing them to user code.
 *
 * {@link TRANSIENT_TRANSPORT_ERROR_CODES} alone could not hold that line,
 * because it can only list failures someone has already seen. The ones it
 * misses are not exotic: HTTP/2 session errors (`ERR_HTTP2_GOAWAY_SESSION` and
 * friends — the shared events pool negotiates h2), TLS handshake failures,
 * `ENETUNREACH` / `EHOSTUNREACH`, and the `AggregateError` a happy-eyeballs
 * connect raises, which carries its codes on `errors[]` where a `cause` walk
 * cannot see them. Each of those used to propagate raw, and a raw
 * `TypeError: fetch failed` is indistinguishable from a user throw by the time
 * it reaches `classifyRunError`: the run failed as `USER_ERROR`, attributing a
 * backend outage to the customer, and the queue never redelivered it.
 *
 * Returns the most specific marker available to name the failure in the error
 * message: the allowlisted code when there is one (so known failures keep
 * reporting exactly what they reported before), otherwise the first `code` in
 * the cause chain, otherwise the innermost error name. `undefined` means the
 * request was never formed and the caller should rethrow as-is.
 */
export function describeTransportFailure(error: unknown): string | undefined {
  const known = getTransientTransportCode(error);
  if (known) return known;

  let firstCode: string | undefined;
  let innermostName: string | undefined;
  let current = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const { code, name, message } = current as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
    };
    // Node Fetch enforces the Fetch Standard's port blocking after Request
    // construction. Its `TypeError: fetch failed` wraps a code-less
    // `Error: bad port`; retrying cannot make that URL acceptable. Preserve
    // the original rejection without duplicating Fetch's blocked-port list.
    if (name === 'Error' && message === 'bad port' && code === undefined) {
      return undefined;
    }
    if (typeof code === 'string' && code) {
      if (REQUEST_CONSTRUCTION_ERROR_CODES.has(code)) return undefined;
      firstCode ??= code;
    }
    if (typeof name === 'string' && name) innermostName = name;
    current = (current as { cause?: unknown }).cause;
  }
  return firstCode ?? innermostName ?? 'unknown';
}

/**
 * Effective per-request timeout. Override via `WORKFLOW_REQUEST_TIMEOUT_MS`
 * (e.g. dialed down on an e2e deployment to exercise the timeout path).
 *
 * Clamped to `[10s, 120s]`, with a warning when a configured value is pulled
 * into range:
 *
 * - **Floor.** Below ~10s this stops being a safety net and becomes the thing
 *   that breaks working requests: a cold workflow-server route, a large event
 *   page, or an ordinary tail-latency blip all exceed a few seconds, and the
 *   resulting timeout is indistinguishable from a broken backend, so the
 *   runtime redrives via the queue instead of making progress.
 * - **Ceiling.** 120s is twice the default and matches the longest a backend
 *   route holds a response (the stream read). Beyond that a hung request would
 *   outlive the callers this deadline exists to protect, which is the failure
 *   mode described on {@link REQUEST_TIMEOUT_MS}. Paths that legitimately
 *   outlast it opt out entirely with `timeoutMs: null` rather than raising
 *   this (see the streamer and the v4 events transport).
 *
 * Note the floor interacts with the run-status long poll: its budget is this
 * value minus the long poll's 10s of headroom, so at exactly the floor
 * the budget clamps to zero and `waitForTerminalStatus` degrades to a plain
 * read. That is intended, and it means 10s is the value at which long polling
 * turns itself off rather than a value that half-works.
 */
export const getRequestTimeoutMs = (): number =>
  envNumber('WORKFLOW_REQUEST_TIMEOUT_MS', REQUEST_TIMEOUT_MS, {
    integer: true,
    min: 10_000,
    max: 120_000,
  });

/**
 * Lightweight debug logger toggle for HTTP requests. Activated when the DEBUG
 * env var contains "workflow:" or is "*".
 *
 * Note: this does not implement full `debug` module semantics (e.g.
 * comma-separated globs, negation with `-`). This limited check is sufficient
 * for enabling HTTP-level debug output.
 */
export const HTTP_DEBUG_ENABLED =
  typeof process !== 'undefined' &&
  typeof process.env.DEBUG === 'string' &&
  (process.env.DEBUG.includes('workflow:') || process.env.DEBUG === '*');

/** Diagnostic response headers worth surfacing in logs and error messages.
 * `x-vercel-mitigated` (`challenge` | `deny`) is set by the Vercel firewall
 * when it intercepts a request in front of the backend; surfacing it makes a
 * firewall block diagnosable from the error message and DEBUG logs. */
const DIAGNOSTIC_HEADERS = [
  'x-vercel-id',
  'x-vercel-error',
  'x-vercel-mitigated',
] as const;

/**
 * The one member the diagnostic/log helpers read headers through. `Headers`
 * satisfies it, and so does the header record a WS reply frame's meta is
 * flattened into, which has no `Headers` to offer.
 */
export interface HeaderLookup {
  get(name: string): string | null;
}

/**
 * Extract the Vercel diagnostic response headers (x-vercel-id /
 * x-vercel-error / x-vercel-mitigated) as `key=value` strings, skipping any
 * that are absent.
 */
export function getVercelDiagnostics(headers: HeaderLookup): string[] {
  return DIAGNOSTIC_HEADERS.flatMap((header) => {
    const value = headers.get(header);
    return value ? [`${header}=${value}`] : [];
  });
}

/**
 * Format the Vercel diagnostic headers as a ` (a=b; c=d)` suffix for error
 * messages, or an empty string when none are present.
 */
export function formatVercelDiagnostics(headers: HeaderLookup): string {
  const diagnostics = getVercelDiagnostics(headers);
  return diagnostics.length > 0 ? ` (${diagnostics.join('; ')})` : '';
}

/**
 * One-line request log, emitted only when HTTP debug is enabled. `label` is a
 * short request identifier (an endpoint path or full URL). Takes the
 * status/headers pair rather than a `Response` so the WS events transport,
 * which has no `Response` to show, logs in the same format as the HTTP path.
 */
export function httpLog(
  method: string,
  label: string,
  response: { status: number; headers: HeaderLookup },
  ms: number
): void {
  if (!HTTP_DEBUG_ENABLED) return;
  const diagnostics = getVercelDiagnostics(response.headers);
  const suffix = diagnostics.length > 0 ? `; ${diagnostics.join('; ')}` : '';
  console.debug(
    `[workflow:world-vercel:http] ${method} ${label} -> ${response.status} (${ms}ms${suffix})`
  );
}

/**
 * On a failed request with `DEBUG` set, print a copy-pasteable `curl` that
 * reproduces it (authorization header stripped). Separate from
 * HTTP_DEBUG_ENABLED so any DEBUG value opts in, matching the original v3
 * behavior.
 */
export function logCurlRepro(
  method: string,
  url: string,
  headers: Headers
): void {
  if (!process.env.DEBUG) return;
  const stringifiedHeaders = Array.from(headers.entries())
    .filter(([key]) => key.toLowerCase() !== 'authorization')
    .map(([key, value]) => `-H "${key}: ${value}"`)
    .join(' ');
  console.error(
    `Failed to fetch, reproduce with:\ncurl -X ${method} ${stringifiedHeaders} "${url}"`
  );
}

/** Parse a `Retry-After` header value (seconds). Used by 425 and 429. */
export function parseRetryAfter(
  value: string | null | undefined
): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Flatten a fetch `Headers` into the plain record both `throwForErrorResponse`
 * (mirroring the v3 `makeRequest` error contract) and the WS transport's
 * `getHeaders` seam expect. Lives here because both `events-v4.ts` and
 * `ws-transport.ts` need it and `events-v4` already imports the transport, so
 * the reverse edge would be a cycle.
 */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Build the typed error for a non-2xx response. This is the single source of
 * truth for the status → error-type contract the runtime branches on:
 *
 *   - 409 → EntityConflictError (start() dedupe, terminal-state transitions)
 *   - 410 → StreamExpiredError when the response code is `stream-expired`,
 *     otherwise RunExpiredError (both terminal)
 *   - 412 → PreconditionFailedError + retryAfter + details (stale precondition
 *     snapshot, the optimistic-concurrency guard on event creation; `details`
 *     carries the events the backend returned inline, when it did)
 *   - 425 → TooEarlyError + retryAfter (step retry pacing; see #1806 for what
 *     happens when a 425 degrades into an untyped error)
 *   - 429 → ThrottleError + retryAfter, EXCEPT a firewall challenge (429 +
 *     `x-vercel-mitigated: challenge`) → retryable transport WorkflowWorldError
 *     (`code: 'TRANSPORT'`); see isFirewallChallenge429
 *   - anything else → WorkflowWorldError with `status` (the hook 404 →
 *     HookNotFoundError translation in events.ts keys off status === 404)
 *
 * Returns the error rather than throwing so callers can `throw` it inside a
 * span helper or pass it through a `buildError` callback.
 */
export function errorForResponse(
  status: number,
  message: string,
  opts: {
    retryAfter?: number;
    code?: string;
    url?: string;
    mitigated?: string | null;
    /** Rejection detail returned by the backend. A stream-expired 410 carries
     * its run, stream, and authoritative retention timestamp here; 412 carries
     * events the backend says the client's snapshot was missing. */
    details?: unknown;
  } = {}
): Error {
  const { retryAfter, code, url, mitigated, details } = opts;
  if (status === 409) return new EntityConflictError(message);
  if (status === 410) {
    if (code === 'stream-expired') {
      const streamDetails =
        details && typeof details === 'object'
          ? (details as {
              runId?: unknown;
              streamId?: unknown;
              expiredAt?: unknown;
            })
          : undefined;
      const expiredAt =
        typeof streamDetails?.expiredAt === 'string'
          ? new Date(streamDetails.expiredAt)
          : undefined;
      return new StreamExpiredError(
        message,
        typeof streamDetails?.runId === 'string'
          ? streamDetails.runId
          : undefined,
        typeof streamDetails?.streamId === 'string'
          ? streamDetails.streamId
          : undefined,
        expiredAt && !Number.isNaN(expiredAt.getTime()) ? expiredAt : undefined
      );
    }
    return new RunExpiredError(message);
  }
  if (status === 412)
    return new PreconditionFailedError(message, { retryAfter, details });
  if (status === 425) return new TooEarlyError(message, { retryAfter });
  if (status === 429) {
    // A firewall challenge can't be solved by a server-to-server client, so map
    // it to the retryable transport path instead of ThrottleError; see
    // isFirewallChallenge429. A genuine application 429 stays a ThrottleError.
    if (isFirewallChallenge429(status, mitigated)) {
      return new WorkflowWorldError(
        `${message} (x-vercel-mitigated=challenge)`,
        {
          url,
          status,
          code: 'TRANSPORT',
          retryAfter,
        }
      );
    }
    return new ThrottleError(message, { retryAfter });
  }
  return new WorkflowWorldError(message, { url, status, code, retryAfter });
}

/**
 * The Vercel firewall answers an intercepted request with HTTP 429 and
 * `x-vercel-mitigated: challenge`. A challenge is meant to be solved by a
 * browser, which our server-to-server client can't do, so the 429 recurs for
 * the life of the incident.
 *
 * Such a 429 must NOT surface as a `ThrottleError`: on the `step_started` write
 * the runtime defers a `ThrottleError` by self-enqueuing a FRESH queue message,
 * which resets the delivery count, so it never backs off past `retryAfter` and
 * never reaches `MAX_QUEUE_DELIVERIES`, hot-looping against an already-overloaded
 * firewall. Mapping it to a retryable transport `WorkflowWorldError` (`code:
 * 'TRANSPORT'`) instead lets the runtime rethrow it to the queue handler,
 * earning the delivery-count backoff AND the delivery cap.
 */
export function isFirewallChallenge429(
  status: number,
  mitigated: string | null | undefined
): boolean {
  return status === 429 && mitigated === 'challenge';
}

/**
 * Resolve the auth token for a direct Vercel-API call (run-key,
 * resolve-deployment). Prefers an explicit token (CLI / config), then
 * `VERCEL_TOKEN` (external tooling), then the per-request OIDC token (runtime).
 * OIDC is last to avoid an unnecessary network call when a token is already
 * available.
 */
export async function resolveVercelApiToken(opts?: {
  token?: string;
}): Promise<string | null> {
  return (
    opts?.token ??
    process.env.VERCEL_TOKEN ??
    (await getVercelOidcToken().catch(() => null))
  );
}

/** Parse the server address/port from a URL for OTEL span attributes.
 *  `wss:` counts as a TLS scheme: the WS events transport reports its upgrade
 *  URL through here, and defaulting it to 80 would misreport the peer. */
function parseServer(url: string): {
  serverAddress?: string;
  serverPort?: number;
} {
  try {
    const parsed = new URL(url);
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    return {
      serverAddress: parsed.hostname,
      serverPort: parsed.port ? parseInt(parsed.port, 10) : secure ? 443 : 80,
    };
  } catch {
    return {};
  }
}

/**
 * Standard OTEL client-span attributes for an HTTP request. Shared by
 * `instrumentedFetch` and the v3 `makeRequest` envelope so both report the
 * same shape. `peerService` doubles as the rpc.service label (Datadog service
 * maps); pass 'workflow-server' for backend calls and 'vercel-api' for direct
 * api.vercel.com calls.
 */
export function httpClientSpanAttributes(args: {
  method: string;
  url: string;
  peerService: string;
}): Record<string, string | number> {
  const { method, url, peerService } = args;
  const { serverAddress, serverPort } = parseServer(url);
  return {
    ...HttpRequestMethod(method),
    ...UrlFull(url),
    ...(serverAddress ? ServerAddress(serverAddress) : {}),
    ...(serverPort ? ServerPort(serverPort) : {}),
    ...PeerService(peerService),
    ...RpcSystem('http'),
    ...RpcService(peerService),
  };
}

export interface HttpClientSpanOptions {
  method: string;
  url: string;
  /**
   * OTEL peer/rpc service label. 'workflow-server' for backend calls (default),
   * 'vercel-api' for direct api.vercel.com calls.
   */
  peerService?: string;
  /**
   * Override the client-span name. Defaults to `http ${method}`. Pass a
   * semantic operation name (e.g. `workflow.stream.write`) so the operation is
   * discoverable in traces beyond the generic HTTP verb.
   */
  spanName?: string;
  /** Extra attributes merged on top of the standard HTTP attributes. */
  attributes?: Attributes;
}

/**
 * Open a CLIENT span for one outgoing request and run `fn` inside it.
 *
 * Split out of `instrumentedFetch` so a request path that cannot go through
 * `fetch` still reports the *same* span: name, kind and the full
 * `httpClientSpanAttributes` set. The WS events transport is the reason this
 * exists: a frame on a multiplexed socket is a request in every sense the
 * caller's trace cares about, but there is no `Response` and no `fetch` call to
 * hang a span off, so it synthesizes one here (see `postEventFrameOverWs`).
 *
 * `fn` runs inside the active span, so anything it injects trace context into
 * is parented to this span rather than to the caller's, which is the contract
 * CLAUDE.md's trace-propagation rule describes.
 */
export async function withHttpClientSpan<T>(
  opts: HttpClientSpanOptions,
  fn: (span?: Span) => Promise<T>
): Promise<T> {
  const {
    method,
    url,
    peerService = 'workflow-server',
    spanName,
    attributes,
  } = opts;
  return trace(
    spanName ?? `http ${method}`,
    { kind: await getSpanKind('CLIENT') },
    async (span) => {
      // Diagnostic (DEBUG only): named spans are created and recording here,
      // yet never found in the backend, so log the exact span identity so the
      // export side can be checked for this specific span id.
      if (spanName && HTTP_DEBUG_ENABLED && span) {
        const ctx = span.spanContext();
        console.warn(
          '[workflow:otel-diag] span-open',
          JSON.stringify({
            spanName,
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            recording: span.isRecording(),
          })
        );
      }
      span?.setAttributes(
        httpClientSpanAttributes({ method, url, peerService })
      );
      if (attributes) span?.setAttributes(attributes);
      return fn(span);
    }
  );
}

/**
 * Stamp a response status onto a client span, marking a non-2xx with the same
 * `error.type` the fetch path uses. Shared so a synthesized span reports a 409
 * identically to a real one: the status → error-type contract is what
 * dashboards filter on, and it must not depend on which transport answered.
 */
export function recordClientSpanStatus(
  span: Span | undefined,
  status: number
): void {
  span?.setAttributes({ ...HttpResponseStatusCode(status) });
  if (status < 200 || status >= 300) {
    span?.setAttributes({ ...ErrorType(`HTTP ${status}`) });
  }
}

export interface InstrumentedFetchOptions extends HttpClientSpanOptions {
  headers: Headers;
  body?: Uint8Array | string;
  /** Undici dispatcher (typed `unknown`; see APIConfig.dispatcher). */
  dispatcher: unknown;
  /**
   * Per-request timeout in ms. Defaults to REQUEST_TIMEOUT_MS. Pass `null` to
   * disable (e.g. stream writes, which buffer arbitrarily large bodies).
   */
  timeoutMs?: number | null;
  /** Optional caller abort signal, composed with the timeout. */
  signal?: AbortSignal;
  /** Inject W3C trace context onto the request headers. Default true. */
  injectTraceContext?: boolean;
  /** Set the X-Request-Time cache-bust header. Default true. */
  cacheBust?: boolean;
  /** Short label for logs (endpoint path). Defaults to the full URL. */
  logLabel?: string;
  /**
   * When set, stamp the measured request round-trip (dispatch -> response
   * received, in ms) onto the client span under this attribute key. For a
   * write PUT this is the per-chunk client->server round-trip (the server acks
   * only after capturing the chunk). Equivalent to the span's own duration;
   * exposed as a named attribute for direct querying.
   */
  durationAttribute?: string;
  /**
   * Build the error to throw on a non-2xx response. Receives the raw Response
   * so the caller can read its body in the right format and craft a path-
   * specific message (the message *strings* legitimately differ per API
   * version). May return an Error or throw directly. When omitted, a generic
   * WorkflowWorldError is built from the status line + body text via
   * `errorForResponse`.
   */
  buildError?: (response: Response) => Error | Promise<Error>;
  /**
   * Notified about the transport-level outcome of the `fetch()` call: the thrown
   * error when no response arrived, `undefined` when one did. An HTTP error
   * status is *not* reported as a failure: the origin answered, so the transport
   * worked. Lets a caller that owns a shared dispatcher retire it when its
   * connections stop delivering (see noteEventsTransportOutcome).
   */
  onTransportOutcome?: (error?: unknown, response?: Response) => void;
  /**
   * Delay the successful transport outcome until the caller consumes the body.
   * Non-2xx bodies consumed by `buildError` are still reported here.
   */
  deferTransportSuccessUntilBody?: boolean;
  /**
   * Called synchronously after the request promise is created, before awaiting
   * its response. This observes local dispatch only; it does not imply that any
   * bytes reached the origin. Must not throw.
   */
  onRequestDispatched?: () => void;
  /** Error code used when the request itself fails before a response arrived. */
  transportErrorCode?: 'TRANSPORT' | 'STREAM_ERROR';
}

/**
 * Issue a single instrumented request through the global `fetch` (so Vercel's
 * observability "outgoing requests" view picks it up) with a caller-supplied
 * undici dispatcher.
 *
 * Handles the shared envelope: OTEL client span + attributes, trace-context
 * injection, cache-bust header, timeout (mapping TimeoutError/AbortError to
 * WorkflowWorldError), `DEBUG` logging, and the non-2xx error path (span error
 * attribute + curl-repro + typed error). Returns the raw `Response` on success
 * so the caller can consume the body in its own format.
 */
export async function instrumentedFetch(
  opts: InstrumentedFetchOptions
): Promise<Response> {
  const {
    method,
    url,
    headers,
    body,
    dispatcher,
    peerService,
    timeoutMs = getRequestTimeoutMs(),
    signal: callerSignal,
    injectTraceContext = true,
    cacheBust = true,
    logLabel,
    buildError,
    spanName,
    attributes,
    durationAttribute,
    onTransportOutcome,
    deferTransportSuccessUntilBody = false,
    onRequestDispatched,
    transportErrorCode = 'TRANSPORT',
  } = opts;
  const label = logLabel ?? url;
  validateHttpUrl(url);

  return withHttpClientSpan(
    { method, url, peerService, spanName, attributes },
    async (span) => {
      // Explicitly propagate trace context so the receiving server can parent
      // its spans to this client span, since the custom undici dispatcher
      // bypasses ambient auto-instrumentation. No-ops when no OTEL SDK is
      // registered.
      if (injectTraceContext) await injectTraceContextIntoHeaders(headers);

      // Unique header per attempt to bypass RSC/Next fetch memoization (and to
      // avoid replaying a memoized truncated body). See:
      // https://github.com/vercel/workflow/issues/618
      if (cacheBust) headers.set('X-Request-Time', Date.now().toString());

      const timeoutSignal =
        timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal =
        callerSignal && timeoutSignal
          ? AbortSignal.any([callerSignal, timeoutSignal])
          : (callerSignal ?? timeoutSignal);

      // With no dispatcher to honor, `WORKFLOW_NODE_HTTP` takes the request
      // off undici altogether rather than leaving it on the undici behind
      // `fetch`. A dispatcher the caller supplied is an instruction to use
      // undici, so it keeps the request on `fetch`.
      //
      // Resolved outside the try: the catch below reads everything it sees as
      // a failure of the request on the wire, and picking an agent happens
      // before there is one.
      const nodeAgents = dispatcher ? undefined : getNodeHttpAgents();
      // Both transports issue the same span against the same URL, so this is
      // the only thing that tells them apart in a trace.
      span?.setAttributes({
        ...WorkflowHttpTransport(nodeAgents ? 'node-http' : 'undici'),
      });

      const start = Date.now();
      let response: Response;
      try {
        const request = nodeAgents
          ? nodeHttpFetch(url, {
              method,
              headers,
              body,
              signal,
              agents: nodeAgents,
              // Match undici's per-phase defaults (which the undici agents
              // inherit implicitly): without these the node:http path arms no
              // stalled-socket deadline, and a `timeoutMs: null` caller would
              // have no deadline at all.
              headersTimeoutMs: NODE_HTTP_HEADERS_TIMEOUT_MS,
              bodyTimeoutMs: NODE_HTTP_BODY_TIMEOUT_MS,
            })
          : fetch(url, {
              method,
              headers,
              body,
              signal,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
              dispatcher,
            } as any);
        onRequestDispatched?.();
        response = await request;
      } catch (error) {
        const elapsed = Date.now() - start;
        // Report the raw error, before the timeout mapping below rewraps it: the
        // undici error code the caller matches on lives in this chain.
        onTransportOutcome?.(error);
        // AbortSignal.timeout() surfaces as a DOMException named 'TimeoutError'.
        // Map to WorkflowWorldError so existing catch sites treat it like any
        // other world transport failure.
        if (
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        ) {
          const message = `${method} ${label} timed out after ${elapsed}ms`;
          const errorCode =
            transportErrorCode === 'STREAM_ERROR' ? 'STREAM_ERROR' : 'TIMEOUT';
          const timeoutError =
            errorCode === 'STREAM_ERROR'
              ? new StreamError(message, { url, cause: error })
              : new WorkflowWorldError(message, {
                  url,
                  code: errorCode,
                  cause: error,
                });
          span?.setAttributes({ ...ErrorType(errorCode) });
          span?.recordException?.(timeoutError);
          throw timeoutError;
        }
        // Nothing below this point saw a response, so anything that is not a
        // request-construction fault is a transport failure — including codes
        // the allowlist has never seen. See describeTransportFailure.
        const transportCode = describeTransportFailure(error);
        if (transportCode) {
          const message = `${method} ${label} transport failure after ${elapsed}ms (${transportCode})`;
          const errorCode =
            transportErrorCode === 'STREAM_ERROR'
              ? 'STREAM_ERROR'
              : 'TRANSPORT';
          const transportError =
            errorCode === 'STREAM_ERROR'
              ? new StreamError(message, { url, cause: error })
              : new WorkflowWorldError(message, {
                  url,
                  code: errorCode,
                  cause: error,
                });
          span?.setAttributes({ ...ErrorType(errorCode) });
          span?.recordException?.(transportError);
          throw transportError;
        }
        throw error;
      }
      const ms = Date.now() - start;
      if (response.ok && !deferTransportSuccessUntilBody) {
        onTransportOutcome?.(undefined, response);
      }

      httpLog(method, label, response, ms);
      recordClientSpanStatus(span, response.status);
      if (durationAttribute) span?.setAttributes({ [durationAttribute]: ms });

      if (!response.ok) {
        logCurlRepro(method, url, headers);
        if (buildError) {
          let error: Error;
          try {
            error = await buildError(response);
          } catch (cause) {
            const transportCode = getTransientTransportCode(cause);
            if (transportCode) {
              onTransportOutcome?.(cause, response);
              const message = `${method} ${label} response body transport failure (${transportCode})`;
              const mappedError =
                transportErrorCode === 'STREAM_ERROR'
                  ? new StreamError(message, { url, cause })
                  : new WorkflowWorldError(message, {
                      url,
                      code: 'TRANSPORT',
                      cause,
                    });
              span?.setAttributes({ ...ErrorType(transportErrorCode) });
              span?.recordException?.(mappedError);
              throw mappedError;
            }
            onTransportOutcome?.(undefined, response);
            throw cause;
          }
          onTransportOutcome?.(undefined, response);
          span?.recordException?.(error);
          throw error;
        }
        let text = '';
        try {
          text = await response.text();
          onTransportOutcome?.(undefined, response);
        } catch (cause) {
          onTransportOutcome?.(cause, response);
        }
        const error = errorForResponse(
          response.status,
          `${method} ${label} -> HTTP ${response.status}: ${response.statusText}${
            text ? ` ${text}` : ''
          }${formatVercelDiagnostics(response.headers)}`,
          {
            url,
            retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
          }
        );
        span?.recordException?.(error);
        throw error;
      }

      return response;
    }
  );
}
