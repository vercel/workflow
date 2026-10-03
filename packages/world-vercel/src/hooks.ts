import { HookNotFoundError, WorkflowWorldError } from '@workflow/errors';
import type {
  CreateHookRequest,
  GetHookParams,
  Hook,
  ListHooksParams,
  PaginatedResponse,
} from '@workflow/world';
import { HookSchema, PaginatedResponseSchema } from '@workflow/world';
import z from 'zod';
import { recordRunAffinity } from './run-affinity.js';
import { normalizeHookData } from './serialized-data.js';
import type { APIConfig } from './utils.js';
import { DEFAULT_RESOLVE_DATA_OPTION, makeRequest } from './utils.js';

// Helper to filter hook data based on resolveData setting
function filterHookData(hook: any, resolveData: 'none' | 'all'): Hook {
  if (resolveData === 'none') {
    const { metadataRef: _metadataRef, ...rest } = hook;
    return rest;
  }
  return normalizeHookData(hook) as Hook;
}
const HookWithRefsSchema = z.compile(
  HookSchema.omit({
    metadata: true,
  }).extend({
    metadataRef: z.any().optional(),
  })
);

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
  const endpoint = `/v2/hooks${queryString ? `?${queryString}` : ''}`;

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
  const endpoint = `/v2/hooks/${encodeURIComponent(hookId)}`;

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
    endpoint: `/v2/hooks/create`,
    options: { method: 'POST' },
    data: { runId, ...data },
    config,
    schema: HookSchema,
  });
}

export async function getHookByToken(
  token: string,
  config?: APIConfig
): Promise<Hook> {
  try {
    const { affinityId, ...hook } = await makeRequest({
      endpoint: `/v2/hooks/by-token?token=${encodeURIComponent(token)}`,
      options: {
        method: 'GET',
      },
      config,
      schema: HookSchema.and(z.object({ affinityId: z.string().optional() })),
    });
    // The server's current routing for the hook's run, used by the resume's
    // invocation right after this lookup.
    recordRunAffinity(hook.runId, affinityId);
    return hook as Hook;
  } catch (error) {
    if (WorkflowWorldError.is(error) && error.status === 404) {
      throw new HookNotFoundError(token);
    }
    throw error;
  }
}

export async function disposeHook(
  hookId: string,
  config?: APIConfig
): Promise<Hook> {
  return makeRequest({
    endpoint: `/v2/hooks/${encodeURIComponent(hookId)}`,
    options: { method: 'DELETE' },
    config,
    schema: HookSchema,
  });
}
