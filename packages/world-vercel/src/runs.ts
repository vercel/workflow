import { WorkflowAPIError, WorkflowRunNotFoundError } from '@workflow/errors';
import {
  type CancelWorkflowRunParams,
  type CreateWorkflowRunRequest,
  type GetWorkflowRunParams,
  type ListWorkflowRunsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  StructuredErrorSchema,
  type UpdateWorkflowRunRequest,
  type WorkflowRun,
  WorkflowRunBaseSchema,
} from '@workflow/world';
import { z } from 'zod';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  dateToStringReplacer,
  deserializeError,
  makeRequest,
  serializeError,
} from './utils.js';

/**
 * Wire format schema for workflow runs coming from the backend.
 * The backend may return error either as:
 * - A JSON string (legacy format) that needs deserialization
 * - An already structured object (new format) with { message, stack?, code? }
 *
 * This is used for validation in makeRequest(), then deserializeError()
 * normalizes both formats into the expected StructuredError object.
 */
const WorkflowRunWireBaseSchema = WorkflowRunBaseSchema.omit({
  error: true,
}).extend({
  // Backend returns error as either a JSON string or structured object
  error: z.union([z.string(), StructuredErrorSchema]).optional(),
});

// Wire schema for resolved data (full input/output)
const WorkflowRunWireSchema = WorkflowRunWireBaseSchema;

// Wire schema for lazy mode with refs instead of data
const WorkflowRunWireWithRefsSchema = WorkflowRunWireBaseSchema.omit({
  input: true,
  output: true,
}).extend({
  // We discard the results of the refs, so we don't care about the type here
  inputRef: z.any().optional(),
  outputRef: z.any().optional(),
  input: z.array(z.any()).optional(),
  output: z.any().optional(),
  blobStorageBytes: z.number().optional(),
  streamStorageBytes: z.number().optional(),
});

// Helper to filter run data based on resolveData setting
function filterRunData(run: any, resolveData: 'none' | 'all'): WorkflowRun {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = run;
    const deserialized = deserializeError<WorkflowRun>(rest);
    return {
      ...deserialized,
      input: [],
      output: undefined,
    };
  }
  return deserializeError<WorkflowRun>(run);
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
  const endpoint = `/v2/runs${queryString ? `?${queryString}` : ''}`;

  const response = (await makeRequest({
    endpoint,
    options: { method: 'GET' },
    config,
    schema: PaginatedResponseSchema(
      remoteRefBehavior === 'lazy'
        ? WorkflowRunWireWithRefsSchema
        : WorkflowRunWireSchema
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
  const run = await makeRequest({
    endpoint: '/v2/runs/create',
    options: {
      method: 'POST',
      body: JSON.stringify(data, dateToStringReplacer),
    },
    config,
    schema: WorkflowRunWireSchema,
  });
  return deserializeError<WorkflowRun>(run);
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
  const endpoint = `/v2/runs/${id}${queryString ? `?${queryString}` : ''}`;

  try {
    const run = await makeRequest({
      endpoint,
      options: { method: 'GET' },
      config,
      schema: (remoteRefBehavior === 'lazy'
        ? WorkflowRunWireWithRefsSchema
        : WorkflowRunWireSchema) as any,
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
    const serialized = serializeError(data);
    const run = await makeRequest({
      endpoint: `/v2/runs/${id}`,
      options: {
        method: 'PUT',
        body: JSON.stringify(serialized, dateToStringReplacer),
      },
      config,
      schema: WorkflowRunWireSchema,
    });
    return deserializeError<WorkflowRun>(run);
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
  const endpoint = `/v2/runs/${id}/cancel${queryString ? `?${queryString}` : ''}`;

  try {
    const run = await makeRequest({
      endpoint,
      options: { method: 'PUT' },
      config,
      schema: (remoteRefBehavior === 'lazy'
        ? WorkflowRunWireWithRefsSchema
        : WorkflowRunWireSchema) as any,
    });

    return filterRunData(run, resolveData);
  } catch (error) {
    if (error instanceof WorkflowAPIError && error.status === 404) {
      throw new WorkflowRunNotFoundError(id);
    }
    throw error;
  }
}
