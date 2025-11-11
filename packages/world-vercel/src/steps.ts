import {
  type CreateStepRequest,
  type GetStepParams,
  type ListWorkflowRunStepsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  type Step,
  StepSchema,
  type UpdateStepRequest,
} from '@workflow/world';
import { z } from 'zod';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  dateToStringReplacer,
  makeRequest,
} from './utils.js';

// Local schema for lazy mode with refs instead of data
const StepWithRefsSchema = StepSchema.omit({
  input: true,
  output: true,
})
  .extend({
    // We discard the results of the refs, so we don't care about the type here
    inputRef: z.any().optional(),
    outputRef: z.any().optional(),
    input: z.array(z.any()).optional(),
    output: z.any().optional(),
  })
  .loose();

// Helper to filter step data based on resolveData setting
function filterStepData(step: any, resolveData: 'none' | 'all'): Step {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = step;
    return {
      ...rest,
      input: [],
      output: undefined,
    };
  }
  return step;
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
      remoteRefBehavior === 'lazy' ? StepWithRefsSchema : StepSchema
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
  return makeRequest({
    endpoint: `/v1/runs/${runId}/steps`,
    options: {
      method: 'POST',
      body: JSON.stringify(data, dateToStringReplacer),
    },
    config,
    schema: StepSchema,
  });
}

export async function updateStep(
  runId: string,
  stepId: string,
  data: UpdateStepRequest,
  config?: APIConfig
): Promise<Step> {
  return makeRequest({
    endpoint: `/v1/runs/${runId}/steps/${stepId}`,
    options: {
      method: 'PUT',
      body: JSON.stringify(data, dateToStringReplacer),
    },
    config,
    schema: StepSchema,
  });
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
      ? StepWithRefsSchema
      : StepSchema) as any,
  });

  return filterStepData(step, resolveData);
}
