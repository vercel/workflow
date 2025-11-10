import {
  type CreateStepRequest,
  type GetStepParams,
  type ListWorkflowRunStepsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  type Step,
  StepSchema,
  StructuredErrorSchema,
  type UpdateStepRequest,
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
 * Wire format schema for steps coming from the backend.
 * The backend returns error as a JSON string, not an object, so we need
 * a schema that accepts the wire format before deserialization.
 *
 * This is used for validation in makeRequest(), then deserializeStepError()
 * transforms the string into the expected StructuredError object.
 */
const StepWireSchema = StepSchema.omit({
  error: true,
}).extend({
  // Backend returns error as a JSON string, not an object
  error: z.string().optional(),
});

// Wire schema for lazy mode with refs instead of data
const StepWireWithRefsSchema = StepWireSchema.omit({
  input: true,
  output: true,
}).extend({
  // We discard the results of the refs, so we don't care about the type here
  inputRef: z.any().optional(),
  outputRef: z.any().optional(),
  input: z.array(z.any()).optional(),
  output: z.any().optional(),
});

// Helper to filter step data based on resolveData setting
function filterStepData(step: any, resolveData: 'none' | 'all'): Step {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = step;
    const deserialized = deserializeError<Step>(rest);
    return {
      ...deserialized,
      input: [],
      output: undefined,
    };
  }
  return deserializeError<Step>(step);
}

// Functions
export async function listWorkflowRunSteps(
  params: ListWorkflowRunStepsParams,
  config?: APIConfig
): Promise<PaginatedResponse<Step>> {
  const {
    runId,
    pagination,
    resolveData = DEFAULT_RESOLVE_DATA_OPTION,
  } = params;

  const searchParams = new URLSearchParams();

  if (pagination?.cursor) searchParams.set('cursor', pagination.cursor);
  if (pagination?.limit) searchParams.set('limit', pagination.limit.toString());
  if (pagination?.sortOrder)
    searchParams.set('sortOrder', pagination.sortOrder);

  // Map resolveData to internal RemoteRefBehavior
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const endpoint = `/v1/runs/${runId}/steps${queryString ? `?${queryString}` : ''}`;

  const response = (await makeRequest({
    endpoint,
    options: { method: 'GET' },
    config,
    schema: PaginatedResponseSchema(
      remoteRefBehavior === 'lazy' ? StepWireWithRefsSchema : StepWireSchema
    ) as any,
  })) as PaginatedResponse<any>;

  return {
    ...response,
    data: response.data.map((step: any) => filterStepData(step, resolveData)),
  };
}

export async function createStep(
  runId: string,
  data: CreateStepRequest,
  config?: APIConfig
): Promise<Step> {
  const step = await makeRequest({
    endpoint: `/v1/runs/${runId}/steps`,
    options: {
      method: 'POST',
      body: JSON.stringify(data, dateToStringReplacer),
    },
    config,
    schema: StepWireSchema,
  });
  return deserializeError<Step>(step);
}

export async function updateStep(
  runId: string,
  stepId: string,
  data: UpdateStepRequest,
  config?: APIConfig
): Promise<Step> {
  const serialized = serializeError(data);
  const step = await makeRequest({
    endpoint: `/v1/runs/${runId}/steps/${stepId}`,
    options: {
      method: 'PUT',
      body: JSON.stringify(serialized, dateToStringReplacer),
    },
    config,
    schema: StepWireSchema,
  });
  return deserializeError<Step>(step);
}

export async function getStep(
  runId: string | undefined,
  stepId: string,
  params?: GetStepParams,
  config?: APIConfig
): Promise<Step> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';

  const searchParams = new URLSearchParams();
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const endpoint = runId
    ? `/v1/runs/${runId}/steps/${stepId}${queryString ? `?${queryString}` : ''}`
    : `/v1/steps/${stepId}${queryString ? `?${queryString}` : ''}`;

  const step = await makeRequest({
    endpoint,
    options: { method: 'GET' },
    config,
    schema: (remoteRefBehavior === 'lazy'
      ? StepWireWithRefsSchema
      : StepWireSchema) as any,
  });

  return filterStepData(step, resolveData);
}
