import os from 'node:os';
import { inspect } from 'node:util';
import { getVercelOidcToken } from '@vercel/oidc';
import { WorkflowAPIError } from '@workflow/errors';
import { type StructuredError, StructuredErrorSchema } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import type { z } from 'zod';
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
 * Hard-coded workflow-server URL override for testing.
 * Set this to test against a different workflow-server version.
 * Leave empty string for production (uses default vercel-workflow.com).
 *
 * Example: 'https://workflow-server-git-branch-name.vercel.sh'
 */
const WORKFLOW_SERVER_URL_OVERRIDE = '';

export interface APIConfig {
  token?: string;
  headers?: RequestInit['headers'];
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
 * Helper to serialize error into a JSON string in the error field.
 * The error field can be either:
 * - A plain string (legacy format, just the error message)
 * - A JSON string with { message, stack, code } (new format)
 */
export function serializeError<T extends { error?: StructuredError }>(
  data: T
): Omit<T, 'error'> & { error?: string } {
  const { error, ...rest } = data;

  // If we have an error, serialize as JSON string
  if (error !== undefined) {
    return {
      ...rest,
      error: JSON.stringify({
        message: error.message,
        stack: error.stack,
        code: error.code,
      }),
    } as Omit<T, 'error'> & { error: string };
  }

  return data as Omit<T, 'error'>;
}

/**
 * Helper to deserialize error field from the backend into a StructuredError object.
 * Handles multiple formats from the backend:
 * - If error is already a structured object → validate and use directly
 * - If error is a JSON string with {message, stack, code} → parse into StructuredError
 * - If error is a plain string → treat as error message with no stack
 * - If no error → undefined
 *
 * This function transforms objects from wire format (where error may be a JSON string
 * or already structured) to domain format (where error is a StructuredError object).
 * The generic type parameter should be the expected output type (WorkflowRun or Step).
 *
 * Note: The type assertion is necessary because the wire format types from Zod schemas
 * have `error?: string | StructuredError` while the domain types have complex error types
 * (e.g., discriminated unions with `error: void` or `error: StructuredError` depending on
 * status), but the transformation preserves all other fields correctly.
 */
export function deserializeError<T extends Record<string, any>>(obj: any): T {
  const { error, ...rest } = obj;

  if (!error) {
    return obj as T;
  }

  // If error is already an object (new format), validate and use directly
  if (typeof error === 'object' && error !== null) {
    const result = StructuredErrorSchema.safeParse(error);
    if (result.success) {
      return {
        ...rest,
        error: {
          message: result.data.message,
          stack: result.data.stack,
          code: result.data.code,
        },
      } as T;
    }
    // Fall through to treat as unknown format
  }

  // If error is a string, try to parse as structured error JSON
  if (typeof error === 'string') {
    try {
      const parsed = StructuredErrorSchema.parse(JSON.parse(error));
      return {
        ...rest,
        error: {
          message: parsed.message,
          stack: parsed.stack,
          code: parsed.code,
        },
      } as T;
    } catch {
      // Backwards compatibility: error is just a plain string
      return {
        ...rest,
        error: {
          message: error,
        },
      } as T;
    }
  }

  // Unknown format - return as-is and let downstream handle it
  return obj as T;
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
    WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
  if (WORKFLOW_SERVER_URL_OVERRIDE && options.usingProxy) {
    headers.set('x-vercel-workflow-api-url', WORKFLOW_SERVER_URL_OVERRIDE);
  }
  return headers;
};

export async function getHttpConfig(config?: APIConfig): Promise<HttpConfig> {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config, { usingProxy });
  const token = config?.token ?? (await getVercelOidcToken());
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { baseUrl, headers, usingProxy };
}

export async function makeRequest<T>({
  endpoint,
  options = {},
  config = {},
  schema,
  data,
}: {
  endpoint: string;
  options?: Omit<RequestInit, 'body'>;
  config?: APIConfig;
  schema: z.ZodSchema<T>;
  /** Request body data - will be CBOR encoded */
  data?: unknown;
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
      // NOTE: Add a unique header to bypass RSC request memoization.
      // See: https://github.com/vercel/workflow/issues/618
      headers.set('X-Request-Time', Date.now().toString());

      // Encode body as CBOR if data is provided
      let body: Buffer | undefined;
      if (data !== undefined) {
        headers.set('Content-Type', 'application/cbor');
        body = encode(data);
      }

      const request = new Request(url, {
        ...options,
        body,
        headers,
      });
      const response = await fetch(request);

      span?.setAttributes({
        ...HttpResponseStatusCode(response.status),
      });

      if (!response.ok) {
        const errorData: { message?: string; code?: string } =
          await parseResponseBody(response)
            .then((r) => r.data as { message?: string; code?: string })
            .catch(() => ({}));
        if (process.env.DEBUG === '1') {
          const stringifiedHeaders = Array.from(headers.entries())
            .map(([key, value]: [string, string]) => `-H "${key}: ${value}"`)
            .join(' ');
          console.error(
            `Failed to fetch, reproduce with:\ncurl -X ${request.method} ${stringifiedHeaders} "${url}"`
          );
        }

        // Parse Retry-After header for 429 responses (value is in seconds)
        let retryAfter: number | undefined;
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('Retry-After');
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!Number.isNaN(parsed)) {
              retryAfter = parsed;
            }
          }
        }

        const error = new WorkflowAPIError(
          errorData.message ||
            `${request.method} ${endpoint} -> HTTP ${response.status}: ${response.statusText}`,
          { url, status: response.status, code: errorData.code, retryAfter }
        );
        // Record error attributes per OTEL conventions
        span?.setAttributes({
          ...ErrorType(errorData.code || `HTTP ${response.status}`),
        });
        span?.recordException?.(error);
        throw error;
      }

      // Parse the response body (CBOR or JSON) with tracing
      let parseResult: ParseResult;
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
      } catch (error) {
        const contentType = response.headers.get('Content-Type') || 'unknown';
        throw new WorkflowAPIError(
          `Failed to parse response body for ${request.method} ${endpoint} (Content-Type: ${contentType}):\n\n${error}`,
          { url, cause: error }
        );
      }

      // Validate against the schema with tracing
      const result = await trace('world.validate', async () => {
        const validationResult = schema.safeParse(parseResult.data);
        if (!validationResult.success) {
          throw new WorkflowAPIError(
            `Schema validation failed for ${request.method} ${endpoint}:\n\n${validationResult.error}\n\nResponse context: ${parseResult.getDebugContext()}`,
            { url, cause: validationResult.error }
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
