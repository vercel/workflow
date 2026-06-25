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
 * This module is the single source of truth for that envelope. It depends only
 * on `telemetry.js`, `@workflow/errors`, and `@vercel/oidc` so it can be
 * imported by both `utils.ts` and `events-v4.ts` without an import cycle —
 * dispatchers are passed in by the caller rather than imported here.
 */

import { getVercelOidcToken } from '@vercel/oidc';
import {
  EntityConflictError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
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
} from './telemetry.js';

/**
 * Per-request timeout for HTTP calls to workflow-server (in ms).
 *
 * Without this, a hung workflow-server response would keep the caller blocked
 * until the platform's `maxDuration` SIGTERM — burning compute and defeating
 * upstream timeout handlers (e.g. the replay timeout).
 */
export const REQUEST_TIMEOUT_MS = 60_000;

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

/** Diagnostic response headers worth surfacing in logs and error messages. */
const DIAGNOSTIC_HEADERS = ['x-vercel-id', 'x-vercel-error'] as const;

/**
 * Extract the Vercel diagnostic response headers (x-vercel-id /
 * x-vercel-error) as `key=value` strings, skipping any that are absent.
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
 *   - 425 → TooEarlyError + retryAfter (step retry pacing — see #1806 for what
 *     happens when a 425 degrades into an untyped error)
 *   - 429 → ThrottleError + retryAfter
 *   - anything else → WorkflowWorldError with `status` (the hook 404 →
 *     HookNotFoundError translation in events.ts keys off status === 404)
 *
 * Returns the error rather than throwing so callers can `throw` it inside a
 * span helper or pass it through a `buildError` callback.
 */
export function errorForResponse(
  status: number,
  message: string,
  opts: { retryAfter?: number; code?: string; url?: string } = {}
): Error {
  const { retryAfter, code, url } = opts;
  if (status === 409) return new EntityConflictError(message);
  if (status === 410) return new RunExpiredError(message);
  if (status === 425) return new TooEarlyError(message, { retryAfter });
  if (status === 429) return new ThrottleError(message, { retryAfter });
  return new WorkflowWorldError(message, { url, status, code, retryAfter });
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
  } = opts;
  const label = logLabel ?? url;

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

      const start = Date.now();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          signal,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
          dispatcher,
        } as any);
      } catch (error) {
        const elapsed = Date.now() - start;
        // AbortSignal.timeout() surfaces as a DOMException named 'TimeoutError'.
        // Map to WorkflowWorldError so existing catch sites treat it like any
        // other world transport failure.
        if (
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        ) {
          const timeoutError = new WorkflowWorldError(
            `${method} ${label} timed out after ${elapsed}ms`,
            { url, cause: error }
          );
          span?.setAttributes({ ...ErrorType('TIMEOUT') });
          span?.recordException?.(timeoutError);
          throw timeoutError;
        }
        throw error;
      }
      const ms = Date.now() - start;

      httpLog(method, label, response, ms);
      span?.setAttributes({ ...HttpResponseStatusCode(response.status) });

      if (!response.ok) {
        span?.setAttributes({ ...ErrorType(`HTTP ${response.status}`) });
        logCurlRepro(method, url, headers);
        if (buildError) {
          const error = await buildError(response);
          span?.recordException?.(error);
          throw error;
        }
        const text = await response.text().catch(() => '');
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
