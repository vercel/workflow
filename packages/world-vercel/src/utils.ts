import os from 'node:os';
import { getVercelOidcToken } from '@vercel/oidc';
import { WorkflowAPIError } from '@workflow/errors';
import { type StructuredError, StructuredErrorSchema } from '@workflow/world';
import type { z } from 'zod';
import { version } from './version.js';

export interface APIConfig {
  baseUrl?: string;
  token?: string;
  headers?: RequestInit['headers'];
  skipProxy?: boolean;
  projectConfig?: {
    projectId?: string;
    teamId?: string;
    environment?: string;
  };
}

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

export function dateToStringReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

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
  const defaultUrl = 'https://vercel-workflow.com/api';
  const defaultProxyUrl = 'https://api.vercel.com/v1/workflow';
  const usingProxy =
    // Skipping proxy is specifically used for e2e testing. Normally, we assume calls from
    // CLI and web UI are not running inside the Vercel runtime environment, and so need to
    // use the proxy for authentication. However, during e2e tests, this is not the case,
    // so we allow skipping the proxy.
    !config?.skipProxy &&
    Boolean(
      config?.baseUrl || (projectConfig?.projectId && projectConfig?.teamId)
    );
  const baseUrl =
    config?.baseUrl || (usingProxy ? defaultProxyUrl : defaultUrl);
  return { baseUrl, usingProxy };
};

export const getHeaders = (config?: APIConfig): Headers => {
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
  return headers;
};

export async function getHttpConfig(config?: APIConfig): Promise<HttpConfig> {
  const headers = getHeaders(config);
  const token = config?.token ?? (await getVercelOidcToken());
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const { baseUrl, usingProxy } = getHttpUrl(config);
  return { baseUrl, headers, usingProxy };
}

export async function makeRequest<T>({
  endpoint,
  options = {},
  config = {},
  schema,
}: {
  endpoint: string;
  options?: RequestInit;
  config?: APIConfig;
  schema: z.ZodSchema<T>;
}): Promise<T> {
  const { baseUrl, headers } = await getHttpConfig(config);
  headers.set('Content-Type', 'application/json');
  // NOTE: Add a unique header to bypass RSC request memoization.
  // See: https://github.com/vercel/workflow/issues/618
  headers.set('X-Request-Time', Date.now().toString());

  const url = `${baseUrl}${endpoint}`;
  const request = new Request(url, {
    ...options,
    headers,
  });
  const response = await fetch(request);

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as any;
    if (process.env.DEBUG === '1') {
      const stringifiedHeaders = Array.from(headers.entries())
        .map(([key, value]: [string, string]) => `-H "${key}: ${value}"`)
        .join(' ');
      console.error(
        `Failed to fetch, reproduce with:\ncurl -X ${request.method} ${stringifiedHeaders} "${url}"`
      );
    }
    throw new WorkflowAPIError(
      errorData.message ||
        `${request.method} ${endpoint} -> HTTP ${response.status}: ${response.statusText}`,
      { url, status: response.status, code: errorData.code }
    );
  }

  const text = await response.text();

  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw new WorkflowAPIError(
      `Failed to parse server response for ${request.method} ${endpoint}:\n\n${error}\n\nResponse body: ${text}`,
      { url, cause: error }
    );
  }
}
