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

/**
 * Wire format schema for steps coming from the backend.
 * Handles error deserialization from wire format.
 */
export const StepWireSchema = StepSchema.omit({
  error: true,
}).extend({
  // Backend returns error either as:
  // - A JSON string (legacy/lazy mode)
  // - An object {message, stack} (when errorRef is resolved)
  // This will be deserialized and mapped to error
  error: z
    .union([
      z.string(),
      z.object({
        message: z.string(),
        stack: z.string().optional(),
        code: z.string().optional(),
      }),
    ])
    .optional(),
  errorRef: z.any().optional(),
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

/**
 * Transform step from wire format to Step interface format.
 * Maps:
 * - error/errorRef → error (deserializing JSON string to StructuredError)
 */
export function deserializeStep(wireStep: any): Step {
  const { error, errorRef, ...rest } = wireStep;

  const result: any = {
    ...rest,
  };

  // Deserialize error to StructuredError
  // The backend returns error as:
  // - error: JSON string (legacy) or object (when resolved)
  // - errorRef: resolved object {message, stack} when remoteRefBehavior=resolve
  const errorSource = error ?? errorRef;
  if (errorSource) {
    if (typeof errorSource === 'string') {
      try {
        const parsed = JSON.parse(errorSource);
        if (typeof parsed === 'object' && parsed.message !== undefined) {
          result.error = {
            message: parsed.message,
            stack: parsed.stack,
            code: parsed.code,
          };
        } else {
          // Parsed but not an object with message
          result.error = { message: String(parsed) };
        }
      } catch {
        // Not JSON, treat as plain string
        result.error = { message: errorSource };
      }
    } else if (typeof errorSource === 'object' && errorSource !== null) {
      // Already an object (from resolved ref)
      result.error = {
        message: errorSource.message ?? 'Unknown error',
        stack: errorSource.stack,
        code: errorSource.code,
      };
    }
  }

  return result as Step;
}

// Helper to filter step data based on resolveData setting
function filterStepData(step: any, resolveData: 'none' | 'all'): Step {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = step;
    const deserialized = deserializeStep(rest);
    return {
      ...deserialized,
      input: [],
      output: undefined,
    };
  }
  return deserializeStep(step);
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
  const endpoint = `/v2/runs/${runId}/steps${queryString ? `?${queryString}` : ''}`;

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
    endpoint: `/v2/runs/${runId}/steps`,
    options: {
      method: 'POST',
      body: JSON.stringify(data, dateToStringReplacer),
    },
    config,
    schema: StepWireSchema,
  });
  return deserializeStep(step);
}

export async function updateStep(
  runId: string,
  stepId: string,
  data: UpdateStepRequest,
  config?: APIConfig
): Promise<Step> {
  // Map interface field names to wire format field names
  const { error: stepError, ...rest } = data;
  const wireData: any = { ...rest };
  if (stepError) {
    wireData.error = JSON.stringify(stepError);
  }
  const step = await makeRequest({
    endpoint: `/v2/runs/${runId}/steps/${stepId}`,
    options: {
      method: 'PUT',
      body: JSON.stringify(wireData, dateToStringReplacer),
    },
    config,
    schema: StepWireSchema,
  });
  return deserializeStep(step);
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
    ? `/v2/runs/${runId}/steps/${stepId}${queryString ? `?${queryString}` : ''}`
    : `/v2/steps/${stepId}${queryString ? `?${queryString}` : ''}`;

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
