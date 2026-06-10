import os from 'node:os';
import { inspect } from 'node:util';
import { getVercelOidcToken } from '@vercel/oidc';
import {
  EntityConflictError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { SerializedData } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import type { z } from 'zod';
import { getDispatcher } from './http-client.js';

import {
  ErrorType,
  getSpanKind,
  HttpRequestMethod,
  HttpResponseStatusCode,
  PeerService,
  RpcService,
  RpcSystem,
  ServerAddress,
  ServerPort,
  trace,
  UrlFull,
  WorldParseFormat,
} from './telemetry.js';
import { version } from './version.js';

/**
 * Lightweight debug logger for HTTP requests. Activated when the DEBUG
 * env var contains "workflow:" or is "*".
 *
 * Note: this does not implement full `debug` module semantics (e.g.
 * comma-separated globs, negation with `-`). It is a simple check
 * sufficient for enabling HTTP-level debug output.
 */
const HTTP_DEBUG_ENABLED =
  typeof process !== 'undefined' &&
  typeof process.env.DEBUG === 'string' &&
  (process.env.DEBUG.includes('workflow:') || process.env.DEBUG === '*');

function httpLog(
  method: string,
  endpoint: string,
  response: Response,
  ms: number
): void {
  if (HTTP_DEBUG_ENABLED) {
    const responseContext = getResponseDiagnosticHeaders(response);
    const diagnosticSuffix =
      responseContext.length > 0 ? `; ${responseContext.join('; ')}` : '';
    console.debug(
      `[workflow:world-vercel:http] ${method} ${endpoint} -> ${response.status} (${ms}ms${diagnosticSuffix})`
    );
  }
}

function getResponseDiagnosticHeaders(response: Response): string[] {
  return ['x-vercel-id', 'x-vercel-error'].flatMap((header) => {
    const value = response.headers.get(header);
    return value ? [`${header}=${value}`] : [];
  });
}

function formatResponseDiagnostics(response: Response): string {
  const headers = getResponseDiagnosticHeaders(response);
  return headers.length > 0 ? ` (${headers.join('; ')})` : '';
}

/**
 * Inline workflow-server URL override. Must remain an empty string on
 * `main` — rewritten by external CI for branch-deployment testing.
 * Prefer `VERCEL_WORKFLOW_SERVER_URL` for deployment-time configuration.
 */
const WORKFLOW_SERVER_URL_OVERRIDE = '';

/**
 * Per-request timeout for HTTP calls to workflow-server (in ms).
 *
 * Without this, a hung workflow-server response would keep the caller
 * blocked until the platform's `maxDuration` SIGTERM — burning compute
 * and defeating upstream timeout handlers (e.g. the replay timeout).
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * HTTP methods that are safe to transparently re-issue inside the adapter.
 * A retry re-sends the request, so it is only safe for idempotent reads — a
 * write could be applied twice. Writes rely on the workflow runtime's
 * idempotent replay (and server-side correlation-id de-duplication) instead.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

/**
 * How many extra times to re-issue an idempotent request when reading or
 * decoding the response body fails transiently — a truncated/terminated
 * stream, a connection reset mid-body, or a gateway returning a non-CBOR/JSON
 * body. The shared `RetryAgent` (see `http-client.ts`) already retries
 * connection and 5xx failures, but body-consumption errors surface *after* it
 * has handed back the response, so they are never seen by its retry logic and
 * must be retried here.
 */
export const MAX_BODY_PARSE_RETRIES = 2;

/** Base delay for the exponential backoff between body-parse retries. */
const BODY_PARSE_RETRY_BASE_MS = 100;

/**
 * Effective workflow-server URL override. The inline constant wins when
 * set; otherwise falls back to the `VERCEL_WORKFLOW_SERVER_URL` env var.
 *
 * When set, requests bypass the default production host
 * (`https://vercel-workflow.com`). When using the proxy
 * (`api.vercel.com/v1/workflow`), this value is forwarded via the
 * `x-vercel-workflow-api-url` header so the proxy routes the request to
 * the override URL.
 */
const getWorkflowServerUrlOverride = (): string =>
  WORKFLOW_SERVER_URL_OVERRIDE || process.env.VERCEL_WORKFLOW_SERVER_URL || '';

export interface APIConfig {
  token?: string;
  headers?: RequestInit['headers'];
  /**
   * Custom HTTP dispatcher passed to every `fetch()` call (e.g. an undici
   * `Agent`/`RetryAgent`). Defaults to a shared undici `RetryAgent`.
   *
   * Typed as `unknown` on purpose: undici's `Dispatcher` type is nominally
   * version-specific (it differs across v6/v7/v8 and the `undici-types`
   * bundled with each `@types/node` major), so a concrete type would reject a
   * dispatcher from a different undici version. Callers may pass any undici
   * version's dispatcher, or any object implementing the dispatcher contract.
   */
  dispatcher?: unknown;
  projectConfig?: {
    /** The real Vercel project ID (e.g., prj_xxx) */
    projectId?: string;
    /** The project name/slug (e.g., my-app), used for dashboard URLs */
    projectName?: string;
    teamId?: string;
    environment?: string;
  };
}

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

/**
 * Pass-through helper that preserves the wire-format error field as-is.
 *
 * In the current event-sourced model (specVersion >= 2), the `error` field
 * on run/step entities is `SerializedData` (a Uint8Array) produced by
 * `dehydrateStepError` / `dehydrateRunError`. Consumers hydrate it via
 * `hydrateStepError` / `hydrateRunError` to reconstruct the original
 * thrown value.
 *
 * This helper exists for backward compatibility with the old API that
 * expected a domain-level transformation. New code should treat the
 * `error` field as opaque `SerializedData`.
 */
export function deserializeError<T extends Record<string, any>>(obj: any): T {
  return obj as T;
}

/**
 * Pass-through helper for outgoing update requests. In the current
 * event-sourced model, the `error` field on `UpdateStepRequest` is
 * `SerializedData` (Uint8Array) and does not need transformation.
 */
export function serializeError<T extends { error?: SerializedData }>(
  data: T
): T {
  return data;
}

const getUserAgent = () => {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  if (deploymentId) {
    return `@workflow/world-vercel/${version} node-${process.version} ${os.platform()} (${os.arch()}) ${deploymentId}`;
  }
  return `@workflow/world-vercel/${version} node-${process.version} ${os.platform()} (${os.arch()})`;
};

export interface HttpConfig {
  baseUrl: string;
  headers: Headers;
  usingProxy: boolean;
}

export const getHttpUrl = (
  config?: APIConfig
): { baseUrl: string; usingProxy: boolean } => {
  const projectConfig = config?.projectConfig;
  const defaultHost =
    getWorkflowServerUrlOverride() || 'https://vercel-workflow.com';
  const customProxyUrl = process.env.WORKFLOW_VERCEL_BACKEND_URL;
  const defaultProxyUrl = 'https://api.vercel.com/v1/workflow';
  // Use proxy when we have project config (for authentication via Vercel API)
  const usingProxy = Boolean(projectConfig?.projectId && projectConfig?.teamId);
  // When using proxy, requests go through api.vercel.com (with x-vercel-workflow-api-url header if override is set)
  // When not using proxy, use the default workflow-server URL (with /api path appended)
  const baseUrl = usingProxy
    ? customProxyUrl || defaultProxyUrl
    : `${defaultHost}/api`;
  return { baseUrl, usingProxy };
};

export const getHeaders = (
  config: APIConfig | undefined,
  options: { usingProxy: boolean }
): Headers => {
  const projectConfig = config?.projectConfig;
  const headers = new Headers(config?.headers);
  headers.set('User-Agent', getUserAgent());
  if (projectConfig) {
    headers.set(
      'x-vercel-environment',
      projectConfig.environment || 'production'
    );
    if (projectConfig.projectId) {
      headers.set('x-vercel-project-id', projectConfig.projectId);
    }
    if (projectConfig.teamId) {
      headers.set('x-vercel-team-id', projectConfig.teamId);
    }
  }
  // Only set workflow-api-url header when using the proxy, since the proxy
  // forwards it to the workflow-server. When not using proxy, requests go
  // directly to the workflow-server so this header has no effect.
  const workflowServerUrlOverride = getWorkflowServerUrlOverride();
  if (workflowServerUrlOverride && options.usingProxy) {
    headers.set('x-vercel-workflow-api-url', workflowServerUrlOverride);
  }
  return headers;
};

export async function getHttpConfig(config?: APIConfig): Promise<HttpConfig> {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config, { usingProxy });

  if (usingProxy) {
    // The api-workflow proxy authenticates the caller with a regular Vercel
    // auth token; it does not accept OIDC. Fail loudly instead of letting
    // an opaque 401 bubble up at request time.
    if (!config?.token) {
      throw new Error(
        'world-vercel: api-workflow proxy requested ' +
          `(${baseUrl}) but no Vercel auth token was provided. ` +
          'Pass one as `config.token` (the SDK reads it from ' +
          '`WORKFLOW_VERCEL_AUTH_TOKEN`).'
      );
    }
    headers.set('Authorization', `Bearer ${config.token}`);
  } else {
    // Direct workflow-server path. The bearer prefers an explicit
    // config.token (CLI / GitHub Actions runner / local dev) and falls
    // back to the per-request Vercel OIDC token. The trusted-sources
    // bypass header always uses the per-request OIDC token.
    let oidcToken: string | undefined;
    try {
      oidcToken = await getVercelOidcToken();
    } catch {
      // No OIDC available outside a Vercel function context.
    }
    const authToken = config?.token ?? oidcToken;
    if (authToken) {
      headers.set('Authorization', `Bearer ${authToken}`);
    }
    if (oidcToken) {
      headers.set('x-vercel-trusted-oidc-idp-token', oidcToken);
    }
  }

  return { baseUrl, headers, usingProxy };
}

export async function makeRequest<T>({
  endpoint,
  options = {},
  config = {},
  schema,
  data,
  onResponse,
}: {
  endpoint: string;
  options?: Omit<RequestInit, 'body'>;
  config?: APIConfig;
  schema: z.ZodSchema<T>;
  /** Request body data - will be CBOR encoded */
  data?: unknown;
  /** Optional callback invoked with the raw Response before body consumption. Use to read response headers. */
  onResponse?: (response: Response) => void;
}): Promise<T> {
  const method = options.method || 'GET';
  const { baseUrl, headers } = await getHttpConfig(config);
  const url = `${baseUrl}${endpoint}`;

  // Parse server address and port from URL for OTEL attributes
  let serverAddress: string | undefined;
  let serverPort: number | undefined;
  try {
    const parsedUrl = new URL(url);
    serverAddress = parsedUrl.hostname;
    serverPort = parsedUrl.port
      ? parseInt(parsedUrl.port, 10)
      : parsedUrl.protocol === 'https:'
        ? 443
        : 80;
  } catch {
    // URL parsing failed, skip these attributes
  }

  // Standard OTEL span name for HTTP client: "{method}"
  // See: https://opentelemetry.io/docs/specs/semconv/http/http-spans/#name
  return trace(
    `http ${method}`,
    { kind: await getSpanKind('CLIENT') },
    async (span) => {
      // Set standard OTEL HTTP client attributes
      span?.setAttributes({
        ...HttpRequestMethod(method),
        ...UrlFull(url),
        ...(serverAddress && ServerAddress(serverAddress)),
        ...(serverPort && ServerPort(serverPort)),
        // Peer service for Datadog service maps
        ...PeerService('workflow-server'),
        ...RpcSystem('http'),
        ...RpcService('workflow-server'),
      });

      headers.set('Accept', 'application/cbor');

      // Encode body as CBOR if data is provided
      let body: Buffer | undefined;
      if (data !== undefined) {
        headers.set('Content-Type', 'application/cbor');
        body = encode(data);
      }

      // Reading or decoding the response body can fail transiently even on a
      // successful (2xx) response — a truncated/terminated stream, a
      // connection reset mid-body, or a gateway returning a non-CBOR/JSON
      // body. The RetryAgent retries connection/5xx failures, but it has
      // already handed back the response by the time we consume the body, so
      // we retry such failures here. Only idempotent reads are re-issued; a
      // write must not be replayed (it could be applied twice).
      const canRetryBody = IDEMPOTENT_METHODS.has(method.toUpperCase());
      let parseResult: ParseResult;
      let responseDiagnostics = '';
      for (let attempt = 0; ; attempt++) {
        // NOTE: Set a unique header on every attempt to bypass RSC request
        // memoization (and to avoid replaying a memoized truncated body).
        // See: https://github.com/vercel/workflow/issues/618
        headers.set('X-Request-Time', Date.now().toString());

        // Compose user-passed abort signal (unused at time of writing)
        // with the max request timeout
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
        const request = new Request(url, {
          ...options,
          body,
          headers,
          signal,
        });
        const fetchStart = Date.now();
        let response: Response;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici v7 dispatcher types don't match @types/node's RequestInit
          response = await fetch(request, {
            dispatcher: getDispatcher(config),
          } as any);
        } catch (error) {
          const elapsed = Date.now() - fetchStart;
          // AbortSignal.timeout() surfaces as a DOMException with name
          // 'TimeoutError'. Map to WorkflowWorldError so existing catch
          // sites treat it like any other world transport failure.
          if (
            error instanceof Error &&
            (error.name === 'TimeoutError' || error.name === 'AbortError')
          ) {
            const timeoutError = new WorkflowWorldError(
              `${method} ${endpoint} timed out after ${elapsed}ms`,
              { url, cause: error }
            );
            span?.setAttributes({ ...ErrorType('TIMEOUT') });
            span?.recordException?.(timeoutError);
            throw timeoutError;
          }
          throw error;
        }
        const fetchMs = Date.now() - fetchStart;

        responseDiagnostics = formatResponseDiagnostics(response);
        httpLog(method, endpoint, response, fetchMs);

        span?.setAttributes({
          ...HttpResponseStatusCode(response.status),
        });

        if (!response.ok) {
          const errorData: { message?: string; code?: string } =
            await parseResponseBody(response)
              .then((r) => r.data as { message?: string; code?: string })
              .catch(() => ({}));
          if (process.env.DEBUG) {
            const stringifiedHeaders = Array.from(headers.entries())
              .filter(([key]) => key.toLowerCase() !== 'authorization')
              .map(([key, value]: [string, string]) => `-H "${key}: ${value}"`)
              .join(' ');
            console.error(
              `Failed to fetch, reproduce with:\ncurl -X ${request.method} ${stringifiedHeaders} "${url}"`
            );
          }

          // Parse Retry-After header (value is in seconds).
          // Used by both 425 (TooEarlyError) and 429 (ThrottleError).
          // Note: RetryAgent handles most 429 retries automatically, but this
          // catches the case where retries are exhausted.
          let retryAfter: number | undefined;
          const retryAfterHeader = response.headers.get('Retry-After');
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!Number.isNaN(parsed)) {
              retryAfter = parsed;
            }
          }

          const defaultMessage =
            (errorData.message ||
              `${request.method} ${endpoint} -> HTTP ${response.status}: ${response.statusText}`) +
            responseDiagnostics;

          // Map specific HTTP status codes to semantic error types
          const throwWithTrace = (error: Error): never => {
            span?.setAttributes({
              ...ErrorType(errorData.code || `HTTP ${response.status}`),
            });
            span?.recordException?.(error);
            throw error;
          };

          if (response.status === 409) {
            throwWithTrace(new EntityConflictError(defaultMessage));
          }
          if (response.status === 410) {
            throwWithTrace(new RunExpiredError(defaultMessage));
          }
          if (response.status === 425) {
            throwWithTrace(new TooEarlyError(defaultMessage, { retryAfter }));
          }
          if (response.status === 429) {
            throwWithTrace(new ThrottleError(defaultMessage, { retryAfter }));
          }

          throwWithTrace(
            new WorkflowWorldError(defaultMessage, {
              url,
              status: response.status,
              code: errorData.code,
              retryAfter,
            })
          );
        }

        // Expose response headers to caller before consuming the body
        onResponse?.(response);

        // Parse the response body (CBOR or JSON) with tracing
        try {
          parseResult = await trace('world.parse', async (parseSpan) => {
            const result = await parseResponseBody(response);
            // Extract format and size from debug context for attributes
            const contentType = response.headers.get('Content-Type') || '';
            const isCbor = contentType.includes('application/cbor');
            parseSpan?.setAttributes({
              ...WorldParseFormat(isCbor ? 'cbor' : 'json'),
            });
            return result;
          });
          // Body read and decoded successfully.
          break;
        } catch (error) {
          if (canRetryBody && attempt < MAX_BODY_PARSE_RETRIES) {
            const backoffMs = BODY_PARSE_RETRY_BASE_MS * 2 ** attempt;
            span?.setAttributes({
              ...ErrorType('PARSE_ERROR_RETRYING'),
            });
            if (HTTP_DEBUG_ENABLED) {
              console.debug(
                `[workflow:world-vercel:http] ${method} ${endpoint} body parse failed (attempt ${attempt + 1}/${MAX_BODY_PARSE_RETRIES + 1}); retrying in ${backoffMs}ms: ${error}`
              );
            }
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          const contentType = response.headers.get('Content-Type') || 'unknown';
          throw new WorkflowWorldError(
            `Failed to parse response body for ${method} ${endpoint}${responseDiagnostics} (Content-Type: ${contentType}):\n\n${error}`,
            { url, code: 'PARSE_ERROR', cause: error }
          );
        }
      }

      // Validate against the schema with tracing
      const result = await trace('world.validate', async () => {
        const validationResult = schema.safeParse(parseResult.data);
        if (!validationResult.success) {
          const issues = validationResult.error.issues
            .map(
              (i) =>
                `  ${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`
            )
            .join('\n');
          const debugContext = process.env.DEBUG
            ? `\n\nResponse context: ${parseResult.getDebugContext()}`
            : '';
          throw new WorkflowWorldError(
            `Schema validation failed for ${method} ${endpoint}${responseDiagnostics}:\n${issues}${debugContext}`,
            { url, code: 'SCHEMA_VALIDATION', cause: validationResult.error }
          );
        }
        return validationResult.data;
      });

      return result;
    }
  );
}

interface ParseResult {
  data: unknown;
  /** Lazily generates debug context for error messages (only called on failure) */
  getDebugContext: () => string;
}

/** Max length for response preview in error messages */
const MAX_PREVIEW_LENGTH = 500;

/**
 * Create a truncated preview of data for error messages.
 */
function createPreview(data: unknown): string {
  const str = inspect(data, { depth: 3, maxArrayLength: 10, breakLength: 120 });
  return str.length > MAX_PREVIEW_LENGTH
    ? `${str.slice(0, MAX_PREVIEW_LENGTH)}...`
    : str;
}

/**
 * Parse response body based on Content-Type header.
 * Supports both CBOR and JSON responses.
 * Returns parsed data along with a lazy debug context generator for error reporting.
 */
async function parseResponseBody(response: Response): Promise<ParseResult> {
  const contentType = response.headers.get('Content-Type') || '';

  if (contentType.includes('application/cbor')) {
    const buffer = await response.arrayBuffer();
    const data = decode(new Uint8Array(buffer));
    return {
      data,
      getDebugContext: () =>
        `Content-Type: ${contentType}, ${buffer.byteLength} bytes (CBOR), preview: ${createPreview(data)}`,
    };
  }

  // Fall back to JSON parsing
  const text = await response.text();
  const data = JSON.parse(text);
  return {
    data,
    getDebugContext: () =>
      `Content-Type: ${contentType}, ${text.length} bytes, preview: ${createPreview(data)}`,
  };
}
