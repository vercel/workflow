import { WorkflowAPIError, WorkflowRunNotFoundError } from '@workflow/errors';
import {
  type CancelWorkflowRunParams,
  type CreateWorkflowRunRequest,
  type GetWorkflowRunParams,
  type ListWorkflowRunsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  type PauseWorkflowRunParams,
  type ResumeWorkflowRunParams,
  type UpdateWorkflowRunRequest,
  type WorkflowRun,
  WorkflowRunSchema,
} from '@workflow/world';
import { z } from 'zod';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  dateToStringReplacer,
  makeRequest,
} from './utils.js';

// Local schema for lazy mode with refs instead of data
const WorkflowRunWithRefsSchema = WorkflowRunSchema.omit({
  input: true,
  output: true,
})
  .extend({
    // We discard the results of the refs, so we don't care about the type here
    inputRef: z.any().optional(),
    outputRef: z.any().optional(),
    input: z.array(z.any()).optional(),
    output: z.any().optional(),
    blobStorageBytes: z.number().optional(),
    streamStorageBytes: z.number().optional(),
  })
  .partial();

// Helper to filter run data based on resolveData setting
function filterRunData(run: any, resolveData: 'none' | 'all'): WorkflowRun {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = run;
    return {
      ...rest,
      input: [],
      output: undefined,
    };
  }
  return run;
}

// Functions

/**
 * This query technically works but should be used sparingly till the backend
 * uses CH to resolve this instead of scanning a dynamo table.
 */
export async function listWorkflowRuns(
  params: ListWorkflowRunsParams = {},
  config?: APIConfig
): Promise<PaginatedResponse<WorkflowRun>> {
  const {
    workflowName,
    status,
    pagination,
    resolveData = DEFAULT_RESOLVE_DATA_OPTION,
  } = params;

  const searchParams = new URLSearchParams();

  if (workflowName) searchParams.set('workflowName', workflowName);
  if (status) searchParams.set('status', status);
  if (pagination?.limit) searchParams.set('limit', pagination.limit.toString());
  if (pagination?.cursor) searchParams.set('cursor', pagination.cursor);
  if (pagination?.sortOrder)
    searchParams.set('sortOrder', pagination.sortOrder);

  // Map resolveData to internal RemoteRefBehavior
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const endpoint = `/v1/runs${queryString ? `?${queryString}` : ''}`;

  const response = (await makeRequest({
    endpoint,
    options: { method: 'GET' },
    config,
    schema: PaginatedResponseSchema(
      remoteRefBehavior === 'lazy'
        ? WorkflowRunWithRefsSchema
        : WorkflowRunSchema
    ),
  })) as PaginatedResponse<WorkflowRun>;

  return {
    ...response,
    data: response.data.map((run: any) => filterRunData(run, resolveData)),
  };
}

export async function createWorkflowRun(
  data: CreateWorkflowRunRequest,
  config?: APIConfig
): Promise<WorkflowRun> {
  return makeRequest({
    endpoint: '/v1/runs/create',
    options: {
      method: 'POST',
      body: JSON.stringify(data, dateToStringReplacer),
    },
    config,
    schema: WorkflowRunSchema,
  });
}

export async function getWorkflowRun(
  id: string,
  params?: GetWorkflowRunParams,
  config?: APIConfig
): Promise<WorkflowRun> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';

  const searchParams = new URLSearchParams();
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const endpoint = `/v1/runs/${id}${queryString ? `?${queryString}` : ''}`;

  try {
    const run = await makeRequest({
      endpoint,
      options: { method: 'GET' },
      config,
      schema: (remoteRefBehavior === 'lazy'
        ? WorkflowRunWithRefsSchema
        : WorkflowRunSchema) as any,
    });

    return filterRunData(run, resolveData);
  } catch (error) {
    if (error instanceof WorkflowAPIError && error.status === 404) {
      throw new WorkflowRunNotFoundError(id);
    }
    throw error;
  }
}

export async function updateWorkflowRun(
  id: string,
  data: UpdateWorkflowRunRequest,
  config?: APIConfig
): Promise<WorkflowRun> {
  try {
    return makeRequest({
      endpoint: `/v1/runs/${id}`,
      options: {
        method: 'PUT',
        body: JSON.stringify(data, dateToStringReplacer),
      },
      config,
      schema: WorkflowRunSchema,
    });
  } catch (error) {
    if (error instanceof WorkflowAPIError && error.status === 404) {
      throw new WorkflowRunNotFoundError(id);
    }
    throw error;
  }
}

export async function cancelWorkflowRun(
  id: string,
  params?: CancelWorkflowRunParams,
  config?: APIConfig
): Promise<WorkflowRun> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';

  const searchParams = new URLSearchParams();
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const endpoint = `/v1/runs/${id}/cancel${queryString ? `?${queryString}` : ''}`;

  try {
    const run = await makeRequest({
      endpoint,
      options: { method: 'PUT' },
      config,
      schema: (remoteRefBehavior === 'lazy'
        ? WorkflowRunWithRefsSchema
        : WorkflowRunSchema) as any,
    });

    return filterRunData(run, resolveData);
  } catch (error) {
    if (error instanceof WorkflowAPIError && error.status === 404) {
      throw new WorkflowRunNotFoundError(id);
    }
    throw error;
  }
}

export async function pauseWorkflowRun(
  id: string,
  params?: PauseWorkflowRunParams,
  config?: APIConfig
): Promise<WorkflowRun> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';

  const searchParams = new URLSearchParams();
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const endpoint = `/v1/runs/${id}/pause${queryString ? `?${queryString}` : ''}`;

  try {
    const run = await makeRequest({
      endpoint,
      options: { method: 'PUT' },
      config,
      schema: (remoteRefBehavior === 'lazy'
        ? WorkflowRunWithRefsSchema
        : WorkflowRunSchema) as any,
    });

    return filterRunData(run, resolveData);
  } catch (error) {
    if (error instanceof WorkflowAPIError && error.status === 404) {
      throw new WorkflowRunNotFoundError(id);
    }
    throw error;
  }
}

export async function resumeWorkflowRun(
  id: string,
  params?: ResumeWorkflowRunParams,
  config?: APIConfig
): Promise<WorkflowRun> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';

  const searchParams = new URLSearchParams();
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const endpoint = `/v1/runs/${id}/resume${queryString ? `?${queryString}` : ''}`;

  try {
    const run = await makeRequest({
      endpoint,
      options: { method: 'PUT' },
      config,
      schema: (remoteRefBehavior === 'lazy'
        ? WorkflowRunWithRefsSchema
        : WorkflowRunSchema) as any,
    });

    return filterRunData(run, resolveData);
  } catch (error) {
    if (error instanceof WorkflowAPIError && error.status === 404) {
      throw new WorkflowRunNotFoundError(id);
    }
    throw error;
  }
}
