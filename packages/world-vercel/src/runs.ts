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

// Schema for structured error with message and stack
const StructuredErrorSchema = z.object({
  message: z.string().optional(),
  stack: z.string().optional(),
});

/**
 * Helper to serialize error + errorStack into a JSON string in the error field.
 * The error field can be either:
 * - A plain string (legacy format, just the error message)
 * - A JSON string with { message, stack } (new format)
 */
function serializeError(data: UpdateWorkflowRunRequest): any {
  const { error, errorStack, ...rest } = data;

  // If we have error or errorStack, serialize as JSON string
  if (error !== undefined || errorStack !== undefined) {
    return {
      ...rest,
      error: JSON.stringify({ message: error, stack: errorStack }),
      // Remove errorStack from the request payload
      errorStack: undefined,
    };
  }

  return data;
}

/**
 * Helper to deserialize error field from the backend into error + errorStack.
 * Handles backwards compatibility:
 * - If error is a JSON string with {message, stack} → parse and split
 * - If error is a plain string → treat as error message with no stack
 * - If no error → both undefined
 */
function deserializeError(run: any): WorkflowRun {
  const { error, ...rest } = run;

  if (!error) {
    return run;
  }

  // Try to parse as structured error JSON
  try {
    const parsed = StructuredErrorSchema.parse(JSON.parse(error));
    return {
      ...rest,
      error: parsed.message,
      errorStack: parsed.stack,
    };
  } catch {
    // Backwards compatibility: error is just a plain string
    return {
      ...rest,
      error: error,
      errorStack: undefined,
    };
  }
}

// Local schema for lazy mode with refs instead of data
const WorkflowRunWithRefsSchema = WorkflowRunSchema.omit({
  input: true,
  output: true,
}).extend({
  // We discard the results of the refs, so we don't care about the type here
  inputRef: z.any().optional(),
  outputRef: z.any().optional(),
  input: z.array(z.any()).optional(),
  output: z.any().optional(),
});

// Helper to filter run data based on resolveData setting
function filterRunData(run: any, resolveData: 'none' | 'all'): WorkflowRun {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = run;
    const deserialized = deserializeError(rest);
    return {
      ...deserialized,
      input: [],
      output: undefined,
    };
  }
  return deserializeError(run);
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
  const run = await makeRequest({
    endpoint: '/v1/runs/create',
    options: {
      method: 'POST',
      body: JSON.stringify(data, dateToStringReplacer),
    },
    config,
    schema: WorkflowRunSchema,
  });
  return deserializeError(run);
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
    const serialized = serializeError(data);
    const run = await makeRequest({
      endpoint: `/v1/runs/${id}`,
      options: {
        method: 'PUT',
        body: JSON.stringify(serialized, dateToStringReplacer),
      },
      config,
      schema: WorkflowRunSchema,
    });
    return deserializeError(run);
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
