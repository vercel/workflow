import { WorkflowAPIError, WorkflowRunNotFoundError } from '@workflow/errors';
import {
  type CancelWorkflowRunParams,
  type CreateWorkflowRunRequest,
  type GetWorkflowRunParams,
  type ListWorkflowRunsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  StructuredErrorSchema,
  type WorkflowRun,
  WorkflowRunBaseSchema,
  type WorkflowRunWithoutData,
} from '@workflow/world';
import { z } from 'zod';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  deserializeError,
  makeRequest,
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
  input: z.instanceof(Uint8Array).optional(),
  output: z.instanceof(Uint8Array).optional(),
  blobStorageBytes: z.number().optional(),
  streamStorageBytes: z.number().optional(),
});

// Overloaded function signatures for filterRunData
function filterRunData(run: any, resolveData: 'none'): WorkflowRunWithoutData;
function filterRunData(run: any, resolveData: 'all'): WorkflowRun;
function filterRunData(
  run: any,
  resolveData: 'none' | 'all'
): WorkflowRun | WorkflowRunWithoutData;

// Implementation
function filterRunData(
  run: any,
  resolveData: 'none' | 'all'
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = run;
    const deserialized = deserializeError<WorkflowRun>(rest);
    return {
      ...deserialized,
      input: undefined,
      output: undefined,
    } as WorkflowRunWithoutData;
  }
  return deserializeError<WorkflowRun>(run);
}

// Functions

/**
 * This query technically works but should be used sparingly till the backend
 * uses CH to resolve this instead of scanning a dynamo table.
 */
export async function listWorkflowRuns(
  params: ListWorkflowRunsParams & { resolveData: 'none' },
  config?: APIConfig
): Promise<PaginatedResponse<WorkflowRunWithoutData>>;
export async function listWorkflowRuns(
  params?: ListWorkflowRunsParams & { resolveData?: 'all' },
  config?: APIConfig
): Promise<PaginatedResponse<WorkflowRun>>;
export async function listWorkflowRuns(
  params?: ListWorkflowRunsParams,
  config?: APIConfig
): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>>;
export async function listWorkflowRuns(
  params: ListWorkflowRunsParams = {},
  config?: APIConfig
): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>> {
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

export async function createWorkflowRunV1(
  data: CreateWorkflowRunRequest,
  config?: APIConfig
): Promise<WorkflowRun> {
  const run = await makeRequest({
    endpoint: '/v1/runs/create',
    options: { method: 'POST' },
    data,
    config,
    schema: WorkflowRunWireSchema,
  });
  return deserializeError<WorkflowRun>(run);
}

export async function getWorkflowRun(
  id: string,
  params: GetWorkflowRunParams & { resolveData: 'none' },
  config?: APIConfig
): Promise<WorkflowRunWithoutData>;
export async function getWorkflowRun(
  id: string,
  params?: GetWorkflowRunParams & { resolveData?: 'all' },
  config?: APIConfig
): Promise<WorkflowRun>;
export async function getWorkflowRun(
  id: string,
  params?: GetWorkflowRunParams,
  config?: APIConfig
): Promise<WorkflowRun | WorkflowRunWithoutData>;
export async function getWorkflowRun(
  id: string,
  params?: GetWorkflowRunParams,
  config?: APIConfig
): Promise<WorkflowRun | WorkflowRunWithoutData> {
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

export async function cancelWorkflowRunV1(
  id: string,
  params: CancelWorkflowRunParams & { resolveData: 'none' },
  config?: APIConfig
): Promise<WorkflowRunWithoutData>;
export async function cancelWorkflowRunV1(
  id: string,
  params?: CancelWorkflowRunParams & { resolveData?: 'all' },
  config?: APIConfig
): Promise<WorkflowRun>;
export async function cancelWorkflowRunV1(
  id: string,
  params?: CancelWorkflowRunParams,
  config?: APIConfig
): Promise<WorkflowRun | WorkflowRunWithoutData>;
export async function cancelWorkflowRunV1(
  id: string,
  params?: CancelWorkflowRunParams,
  config?: APIConfig
): Promise<WorkflowRun | WorkflowRunWithoutData> {
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
