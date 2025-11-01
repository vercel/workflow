import { getVercelOidcToken } from '@vercel/oidc';
import { WorkflowAPIError } from '@workflow/errors';
import { ZodError, type z } from 'zod';

export interface APIConfig {
  baseUrl?: string;
  token?: string;
  headers?: RequestInit['headers'];
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
  const usingProxy = Boolean(
    config?.baseUrl || (projectConfig?.projectId && projectConfig?.teamId)
  );
  const baseUrl =
    config?.baseUrl || (usingProxy ? defaultProxyUrl : defaultUrl);
  return { baseUrl, usingProxy };
};

export const getHeaders = (config?: APIConfig): Headers => {
  const projectConfig = config?.projectConfig;
  const headers = new Headers(config?.headers);
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

  const url = `${baseUrl}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as any;
    if (process.env.DEBUG === '1') {
      const stringifiedHeaders = Array.from(headers.entries())
        .map(([key, value]: [string, string]) => `-H "${key}: ${value}"`)
        .join(' ');
      console.error(
        `Failed to fetch, reproduce with:\ncurl -X ${options.method} ${stringifiedHeaders} "${url}"`
      );
    }
    throw new WorkflowAPIError(
      errorData.message ||
        `${options.method ?? 'GET'} ${endpoint} -> HTTP ${response.status}: ${response.statusText}`,
      { url, status: response.status, code: errorData.code }
    );
  }

  try {
    const text = await response.text();
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof ZodError) {
      throw new WorkflowAPIError(
        `Failed to parse server response for ${options.method ?? 'GET'} ${endpoint}: ${error.message}`,
        { url, cause: error }
      );
    }
    throw new WorkflowAPIError(
      `Failed to parse server response for ${options.method ?? 'GET'} ${endpoint}`,
      { url, cause: error }
    );
  }
}
