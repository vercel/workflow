/**
 * Shared HTTP request core for the world-vercel adapter.
 *
 * Every outgoing request from world-vercel goes through one of a few
 * higher-level clients — the v3 `makeRequest`, the v4 events client, the
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

import { getVercelOidcToken } from '@vercel/oidc';
import {
  EntityConflictError,
  PreconditionFailedError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { nodeHttpFetch } from '@workflow/world/node-http.js';
import { getNodeHttpAgents, getNodeHttpPhaseTimeouts } from './http-client.js';
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
 * until the platform's `maxDuration` SIGTERM — burning compute and defeating
 * upstream timeout handlers (e.g. the replay timeout).
 *
 * This is the outer backstop, not the first line of defense: the shared
 * dispatcher's `headersTimeout`/`bodyTimeout` fire earlier (see http-client.ts)
 * and produce a typed, retryable `UND_ERR_*_TIMEOUT` instead of the opaque
 * abort this deadline raises. Keep it above those so the ordering holds — it
 * still covers the whole request (including retries the dispatcher performs
 * internally, and time spent outside undici's own timers).
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Transport failures that are safe to classify as transient infrastructure
 * errors. `fetch()` usually wraps the undici error in `TypeError: fetch
 * failed`, so callers must inspect the cause chain rather than only the
 * top-level error.
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

/** Walk a bounded cause chain looking for a transient transport error code. */
export function getTransientTransportCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; current != null && depth < 8; depth++) {
    if (typeof current === 'object' && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (
        typeof code === 'string' &&
        TRANSIENT_TRANSPORT_ERROR_CODES.has(code)
      ) {
        return code;
      }
    }
    current = (current as { cause?: unknown })?.cause;
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
 * Lightweight debug logger toggle for HTTP requests. Activated when the DEBUG
 * env var contains "workflow:" or is "*".
 *
 * Note: this does not implement full `debug` module semantics (e.g.
 * comma-separated globs, negation with `-`). It is a simple check sufficient
 * for enabling HTTP-level debug output.
 */
export const HTTP_DEBUG_ENABLED =
  typeof process !== 'undefined' &&
  typeof process.env.DEBUG === 'string' &&
  (process.env.DEBUG.includes('workflow:') || process.env.DEBUG === '*');

/** Diagnostic response headers worth surfacing in logs and error messages.
 * `x-vercel-mitigated` (`challenge` | `deny`) is set by the Vercel firewall
 * when it intercepts a request in front of the backend — surfacing it makes a
 * firewall block diagnosable from the error message and DEBUG logs. */
const DIAGNOSTIC_HEADERS = [
  'x-vercel-id',
  'x-vercel-error',
  'x-vercel-mitigated',
] as const;

/**
 * Extract the Vercel diagnostic response headers (x-vercel-id /
 * x-vercel-error / x-vercel-mitigated) as `key=value` strings, skipping any
 * that are absent.
 */
export function getVercelDiagnostics(headers: Headers): string[] {
  return DIAGNOSTIC_HEADERS.flatMap((header) => {
    const value = headers.get(header);
    return value ? [`${header}=${value}`] : [];
  });
}

/**
 * Format the Vercel diagnostic headers as a ` (a=b; c=d)` suffix for error
 * messages, or an empty string when none are present.
 */
export function formatVercelDiagnostics(headers: Headers): string {
  const diagnostics = getVercelDiagnostics(headers);
  return diagnostics.length > 0 ? ` (${diagnostics.join('; ')})` : '';
}

/**
 * One-line request log, emitted only when HTTP debug is enabled. `label` is a
 * short request identifier (an endpoint path or full URL).
 */
export function httpLog(
  method: string,
  label: string,
  response: Response,
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
 * Build the typed error for a non-2xx response. This is the single source of
 * truth for the status → error-type contract the runtime branches on:
 *
 *   - 409 → EntityConflictError (start() dedupe, terminal-state transitions)
 *   - 410 → RunExpiredError (runtime exits without retrying)
 *   - 412 → PreconditionFailedError + retryAfter (stale `stateUpdatedAt`
 *     snapshot — the optimistic-concurrency guard on event creation)
 *   - 425 → TooEarlyError + retryAfter (step retry pacing — see #1806 for what
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
  } = {}
): Error {
  const { retryAfter, code, url, mitigated } = opts;
  if (status === 409) return new EntityConflictError(message);
  if (status === 410) return new RunExpiredError(message);
  if (status === 412)
    return new PreconditionFailedError(message, { retryAfter });
  if (status === 425) return new TooEarlyError(message, { retryAfter });
  if (status === 429) {
    // A firewall challenge can't be solved by a server-to-server client, so map
    // it to the retryable transport path instead of ThrottleError — see
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
 * which resets the delivery count — so it never backs off past `retryAfter` and
 * never reaches `MAX_QUEUE_DELIVERIES`, hot-looping against an already-overloaded
 * firewall. Mapping it to a retryable transport `WorkflowWorldError` (`code:
 * 'TRANSPORT'`) instead lets the runtime rethrow it to the queue handler —
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

/** Parse the server address/port from a URL for OTEL span attributes. */
function parseServer(url: string): {
  serverAddress?: string;
  serverPort?: number;
} {
  try {
    const parsed = new URL(url);
    return {
      serverAddress: parsed.hostname,
      serverPort: parsed.port
        ? parseInt(parsed.port, 10)
        : parsed.protocol === 'https:'
          ? 443
          : 80,
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

export interface InstrumentedFetchOptions {
  method: string;
  url: string;
  headers: Headers;
  body?: Uint8Array | string;
  /** Undici dispatcher (typed `unknown`; see APIConfig.dispatcher). */
  dispatcher: unknown;
  /**
   * OTEL peer/rpc service label. 'workflow-server' for backend calls (default),
   * 'vercel-api' for direct api.vercel.com calls.
   */
  peerService?: string;
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
   * status is *not* reported as a failure — the origin answered, so the transport
   * worked. Lets a caller that owns a shared dispatcher retire it when its
   * connections stop delivering (see noteEventsTransportOutcome).
   */
  onTransportOutcome?: (error?: unknown) => void;
  /**
   * Delay the successful transport outcome until the caller consumes the body.
   * Streamed responses can fail after their headers arrive, so treating
   * `fetch()` resolution as success would hide those failures from a caller's
   * connection-pool recycler.
   */
  deferTransportSuccessUntilBody?: boolean;
}

/**
 * Issue a single instrumented request through the global `fetch` (so Vercel's
 * observability "outgoing requests" view picks it up) with a caller-supplied
 * undici dispatcher.
 *
 * Handles the shared envelope — OTEL client span + attributes, trace-context
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
    peerService = 'workflow-server',
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal: callerSignal,
    injectTraceContext = true,
    cacheBust = true,
    logLabel,
    buildError,
    onTransportOutcome,
    deferTransportSuccessUntilBody = false,
  } = opts;
  const label = logLabel ?? url;
  validateHttpUrl(url);

  return trace(
    `http ${method}`,
    { kind: await getSpanKind('CLIENT') },
    async (span) => {
      span?.setAttributes(
        httpClientSpanAttributes({ method, url, peerService })
      );

      // Explicitly propagate trace context so the receiving server can parent
      // its spans to this client span — the custom undici dispatcher bypasses
      // ambient auto-instrumentation. No-ops when no OTEL SDK is registered.
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
        response = nodeAgents
          ? await nodeHttpFetch(url, {
              method,
              headers,
              body,
              signal,
              agents: nodeAgents,
              // Same per-phase deadlines the undici agents are configured
              // with: without these the node:http path arms no stalled-socket
              // deadline, and a `timeoutMs: null` caller would have no deadline
              // at all.
              ...getNodeHttpPhaseTimeouts(),
            })
          : await fetch(url, {
              method,
              headers,
              body,
              signal,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
              dispatcher,
            } as any);
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
          const timeoutError = new WorkflowWorldError(
            `${method} ${label} timed out after ${elapsed}ms`,
            { url, code: 'TIMEOUT', cause: error }
          );
          span?.setAttributes({ ...ErrorType('TIMEOUT') });
          span?.recordException?.(timeoutError);
          throw timeoutError;
        }
        // Nothing below this point saw a response, so anything that is not a
        // request-construction fault is a transport failure — including codes
        // the allowlist has never seen. See describeTransportFailure.
        const transportCode = describeTransportFailure(error);
        if (transportCode) {
          const transportError = new WorkflowWorldError(
            `${method} ${label} transport failure after ${elapsed}ms (${transportCode})`,
            { url, code: 'TRANSPORT', cause: error }
          );
          span?.setAttributes({ ...ErrorType('TRANSPORT') });
          span?.recordException?.(transportError);
          throw transportError;
        }
        throw error;
      }
      const ms = Date.now() - start;
      if (!deferTransportSuccessUntilBody) onTransportOutcome?.();

      httpLog(method, label, response, ms);
      span?.setAttributes({ ...HttpResponseStatusCode(response.status) });

      if (!response.ok) {
        span?.setAttributes({ ...ErrorType(`HTTP ${response.status}`) });
        logCurlRepro(method, url, headers);
        if (buildError) {
          let error: Error;
          try {
            error = await buildError(response);
          } catch (cause) {
            const transportCode = getTransientTransportCode(cause);
            if (transportCode) {
              if (deferTransportSuccessUntilBody) {
                onTransportOutcome?.(cause);
              }
              const transportError = new WorkflowWorldError(
                `${method} ${label} response body transport failure (${transportCode})`,
                { url, code: 'TRANSPORT', cause }
              );
              span?.setAttributes({ ...ErrorType('TRANSPORT') });
              span?.recordException?.(transportError);
              throw transportError;
            }
            if (deferTransportSuccessUntilBody) {
              onTransportOutcome?.(cause);
            }
            throw cause;
          }
          if (deferTransportSuccessUntilBody) onTransportOutcome?.();
          span?.recordException?.(error);
          throw error;
        }
        const text = await response.text().catch(() => '');
        if (deferTransportSuccessUntilBody) onTransportOutcome?.();
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
