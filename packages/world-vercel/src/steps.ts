import {
  type CreateStepRequest,
  type GetStepParams,
  type ListWorkflowRunStepsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  SerializedDataSchema,
  type Step,
  StepSchema,
  type StepWithoutData,
  type UpdateStepRequest,
} from '@workflow/world';
import { z } from 'zod';
import { normalizeStepData } from './serialized-data.js';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  makeRequest,
  serializeError,
} from './utils.js';

/**
 * Wire format schema for steps coming from the backend.
 *
 * `error` is SerializedData (Uint8Array) produced by dehydrateStepError.
 * For backward compatibility with legacy wire formats, we also accept
 * any other shape and let the resolved `errorRef` supersede it when present.
 */
export const StepWireSchema = StepSchema.omit({
  error: true,
}).extend({
  error: z.union([SerializedDataSchema, z.any()]).optional(),
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
 *
 * The `error` field on Step is SerializedData (Uint8Array) from the
 * serialization pipeline — we pass through the wire-format `error` (or
 * the resolved `errorRef`) as-is. Consumers hydrate via `hydrateStepError`.
 *
 * Wire→shape only: this does NOT decompress. The runtime write paths
 * (createStep/updateStep/events.create) re-hydrate step payloads through
 * `hydrateStepReturnValue`/`hydrateStepError`, which decompress on their
 * own, so decompressing here would be redundant work and would skew the
 * runtime's deserialize compression telemetry. Compression normalization
 * for o11y/display is applied in {@link filterStepData}, the read path.
 */
export function deserializeStep(wireStep: any): Step {
  const { error, errorRef, ...rest } = wireStep;
  const result: any = { ...rest };
  const errorSource = error ?? errorRef;
  if (errorSource !== undefined && errorSource !== null) {
    result.error = errorSource;
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
// to match other World implementations (world-local, world-postgres).
//
// This is the read/display entry point, so it decompresses gzip/zstd
// payload wrappers via `normalizeStepData` (the runtime write paths use
// `deserializeStep` directly and skip this — see its doc comment).
function filterStepData(
  step: any,
  resolveData: 'none' | 'all'
): Step | StepWithoutData {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = step;
    const deserialized = normalizeStepData(deserializeStep(rest));
    return {
      ...deserialized,
      input: undefined,
      output: undefined,
    } as StepWithoutData;
  }
  return normalizeStepData(deserializeStep(step));
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
  const endpoint = `/v2/runs/${encodeURIComponent(runId)}/steps${queryString ? `?${queryString}` : ''}`;

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
    endpoint: `/v2/runs/${encodeURIComponent(runId)}/steps`,
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
    endpoint: `/v2/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`,
    options: { method: 'PUT' },
    data: serialized,
    config,
    schema: StepWireSchema,
  });
  return deserializeStep(step);
}

export async function getStep(
  runId: string,
  stepId: string,
  params: GetStepParams & { resolveData: 'none' },
  config?: APIConfig
): Promise<StepWithoutData>;
export async function getStep(
  runId: string,
  stepId: string,
  params?: GetStepParams & { resolveData?: 'all' },
  config?: APIConfig
): Promise<Step>;
export async function getStep(
  runId: string,
  stepId: string,
  params?: GetStepParams,
  config?: APIConfig
): Promise<Step | StepWithoutData>;
export async function getStep(
  runId: string,
  stepId: string,
  params?: GetStepParams,
  config?: APIConfig
): Promise<Step | StepWithoutData> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';

  const searchParams = new URLSearchParams();
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const endpoint = `/v2/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}${queryString ? `?${queryString}` : ''}`;

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
