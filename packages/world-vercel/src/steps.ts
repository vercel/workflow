import {
  type CreateStepRequest,
  type GetStepParams,
  type ListWorkflowRunStepsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  type Step,
  StepSchema,
  type StepWithoutData,
  type UpdateStepRequest,
} from '@workflow/world';
import { z } from 'zod';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  makeRequest,
  serializeError,
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
  input: z.instanceof(Uint8Array).optional(),
  output: z.instanceof(Uint8Array).optional(),
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

// Overloaded function signatures for filterStepData
function filterStepData(step: any, resolveData: 'none'): StepWithoutData;
function filterStepData(step: any, resolveData: 'all'): Step;
function filterStepData(
  step: any,
  resolveData: 'none' | 'all'
): Step | StepWithoutData;

// Implementation - when resolveData='none', returns Step with input/output set to undefined
// to match other World implementations (world-local, world-postgres)
function filterStepData(
  step: any,
  resolveData: 'none' | 'all'
): Step | StepWithoutData {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = step;
    const deserialized = deserializeStep(rest);
    return {
      ...deserialized,
      input: undefined,
      output: undefined,
    } as StepWithoutData;
  }
  return deserializeStep(step);
}

// Functions
export async function listWorkflowRunSteps(
  params: ListWorkflowRunStepsParams & { resolveData: 'none' },
  config?: APIConfig
): Promise<PaginatedResponse<StepWithoutData>>;
export async function listWorkflowRunSteps(
  params: ListWorkflowRunStepsParams & { resolveData?: 'all' },
  config?: APIConfig
): Promise<PaginatedResponse<Step>>;
export async function listWorkflowRunSteps(
  params: ListWorkflowRunStepsParams,
  config?: APIConfig
): Promise<PaginatedResponse<Step | StepWithoutData>>;
export async function listWorkflowRunSteps(
  params: ListWorkflowRunStepsParams,
  config?: APIConfig
): Promise<PaginatedResponse<Step | StepWithoutData>> {
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
    options: { method: 'POST' },
    data,
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
  const serialized = serializeError(data);
  const step = await makeRequest({
    endpoint: `/v2/runs/${runId}/steps/${stepId}`,
    options: { method: 'PUT' },
    data: serialized,
    config,
    schema: StepWireSchema,
  });
  return deserializeStep(step);
}

export async function getStep(
  runId: string | undefined,
  stepId: string,
  params: GetStepParams & { resolveData: 'none' },
  config?: APIConfig
): Promise<StepWithoutData>;
export async function getStep(
  runId: string | undefined,
  stepId: string,
  params?: GetStepParams & { resolveData?: 'all' },
  config?: APIConfig
): Promise<Step>;
export async function getStep(
  runId: string | undefined,
  stepId: string,
  params?: GetStepParams,
  config?: APIConfig
): Promise<Step | StepWithoutData>;
export async function getStep(
  runId: string | undefined,
  stepId: string,
  params?: GetStepParams,
  config?: APIConfig
): Promise<Step | StepWithoutData> {
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
