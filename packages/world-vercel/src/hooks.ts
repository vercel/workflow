import type {
  CreateHookRequest,
  GetHookParams,
  Hook,
  ListHooksParams,
  PaginatedResponse,
} from '@workflow/world';
import { HookSchema, PaginatedResponseSchema } from '@workflow/world';
import z from 'zod';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  dateToStringReplacer,
  makeRequest,
} from './utils.js';

// Helper to filter hook data based on resolveData setting
function filterHookData(hook: any, resolveData: 'none' | 'all'): Hook {
  if (resolveData === 'none') {
    const { metadataRef: _metadataRef, ...rest } = hook;
    return rest;
  }
  return hook;
}
const HookWithRefsSchema = HookSchema.omit({
  metadata: true,
}).extend({
  metadataRef: z.any().optional(),
});

export async function listHooks(
  params: ListHooksParams,
  config?: APIConfig
): Promise<PaginatedResponse<Hook>> {
  const {
    runId,
    pagination,
    resolveData = DEFAULT_RESOLVE_DATA_OPTION,
  } = params;

  const searchParams = new URLSearchParams();

  if (pagination?.limit) searchParams.set('limit', pagination.limit.toString());
  if (pagination?.cursor) searchParams.set('cursor', pagination.cursor);
  if (pagination?.sortOrder)
    searchParams.set('sortOrder', pagination.sortOrder);

  // Map resolveData to internal RemoteRefBehavior
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  if (runId) searchParams.set('runId', runId);

  const queryString = searchParams.toString();
  const endpoint = `/v1/hooks${queryString ? `?${queryString}` : ''}`;

  const response = (await makeRequest({
    endpoint,
    options: { method: 'GET' },
    config,
    schema: PaginatedResponseSchema(
      remoteRefBehavior === 'lazy' ? HookWithRefsSchema : HookSchema
    ),
  })) as PaginatedResponse<Hook>;

  return {
    ...response,
    data: response.data.map((hook: any) => filterHookData(hook, resolveData)),
  };
}

export async function getHook(
  hookId: string,
  params?: GetHookParams,
  config?: APIConfig
): Promise<Hook> {
  const resolveData = params?.resolveData || 'all';
  const endpoint = `/v1/hooks/${hookId}`;

  const hook = await makeRequest({
    endpoint,
    options: { method: 'GET' },
    config,
    schema: HookSchema,
  });

  return filterHookData(hook, resolveData);
}

export async function createHook(
  runId: string,
  data: CreateHookRequest,
  config?: APIConfig
): Promise<Hook> {
  return makeRequest({
    endpoint: `/v1/hooks/create`,
    options: {
      method: 'POST',
      body: JSON.stringify(
        {
          runId,
          ...data,
        },
        dateToStringReplacer
      ),
    },
    config,
    schema: HookSchema,
  });
}

export async function getHookByToken(
  token: string,
  config?: APIConfig
): Promise<Hook> {
  return makeRequest({
    endpoint: `/v1/hooks/by-token?token=${encodeURIComponent(token)}`,
    options: {
      method: 'GET',
    },
    config,
    schema: HookSchema,
  });
}

export async function disposeHook(
  hookId: string,
  config?: APIConfig
): Promise<Hook> {
  return makeRequest({
    endpoint: `/v1/hooks/${hookId}`,
    options: { method: 'DELETE' },
    config,
    schema: HookSchema,
  });
}
