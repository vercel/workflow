import { WorkflowRunNotFoundError, WorkflowWorldError } from '@workflow/errors';
import {
  type AttributeChange,
  type CancelWorkflowRunParams,
  type CreateWorkflowRunRequest,
  type ExperimentalSetAttributesResult,
  type GetWorkflowRunParams,
  type ListWorkflowRunsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  SerializedDataSchema,
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
 *
 * `error` is SerializedData produced by `dehydrateRunError` in the new
 * (specVersion >= 2) format. For backward compatibility with legacy
 * records, we also accept any other shape and let `deserializeError`
 * normalize it.
 *
 * `errorCode` is a separate plaintext metadata field used for routing
 * and classification.
 */
export const WorkflowRunWireBaseSchema = WorkflowRunBaseSchema.omit({
  error: true,
  errorCode: true,
}).extend({
  error: z.union([SerializedDataSchema, z.any()]).optional(),
  errorCode: z.string().optional(),
  // Not part of the World interface, but passed through for direct consumers and debugging
  blobStorageBytes: z.number().optional(),
  streamStorageBytes: z.number().optional(),
});

// Wire schema for resolved data (full input/output)
const WorkflowRunWireSchema = WorkflowRunWireBaseSchema;

// Wire schema for lazy mode with refs instead of data
// input/output can be Uint8Array (v2) or any JSON (legacy v1)
const WorkflowRunWireWithRefsSchema = WorkflowRunWireBaseSchema.omit({
  input: true,
  output: true,
}).extend({
  // We discard the results of the refs, so we don't care about the type here
  inputRef: z.any().optional(),
  outputRef: z.any().optional(),
  // Accept both Uint8Array (v2 format) and any (legacy v1 JSON format)
  input: z.union([z.instanceof(Uint8Array), z.any()]).optional(),
  output: z.union([z.instanceof(Uint8Array), z.any()]).optional(),
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
  const endpoint = `/v2/runs/${encodeURIComponent(id)}${queryString ? `?${queryString}` : ''}`;

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
    if (error instanceof WorkflowWorldError && error.status === 404) {
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
  const endpoint = `/v1/runs/${encodeURIComponent(id)}/cancel${queryString ? `?${queryString}` : ''}`;

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
    if (error instanceof WorkflowWorldError && error.status === 404) {
      throw new WorkflowRunNotFoundError(id);
    }
    throw error;
  }
}

/**
 * Wire response schema for `experimentalSetAttributes`. The backend
 * returns the post-merge attribute snapshot so callers don't need to
 * issue a follow-up read.
 */
const ExperimentalSetAttributesResponseSchema = z.object({
  attributes: z.record(z.string(), z.string()),
});

/**
 * Apply attribute changes to a workflow run. The body shape mirrors the
 * future `attr_set` event's `eventData.changes`, so the wire contract is
 * forward-compatible with the full 5.0.0 attributes feature — only the
 * endpoint path changes.
 *
 * `options.allowReservedAttributes` opts the request into permitting
 * `$`-prefixed keys (framework-only — see the SDK helper for details).
 * The flag is forwarded to the server via the request body.
 *
 * EXPERIMENTAL: tied to the MVP write-only attributes API. See
 * `docs/content/docs/v5/changelog/attributes-mvp.mdx`.
 */
export async function experimentalSetAttributes(
  runId: string,
  changes: AttributeChange[],
  options?: { allowReservedAttributes?: boolean },
  config?: APIConfig
): Promise<ExperimentalSetAttributesResult> {
  try {
    const response = await makeRequest({
      endpoint: `/v2/runs/${encodeURIComponent(runId)}/attributes`,
      options: { method: 'POST' },
      data: options?.allowReservedAttributes
        ? { changes, allowReservedAttributes: true }
        : { changes },
      config,
      schema: ExperimentalSetAttributesResponseSchema,
    });
    return { attributes: response.attributes };
  } catch (error) {
    if (error instanceof WorkflowWorldError && error.status === 404) {
      throw new WorkflowRunNotFoundError(runId);
    }
    throw error;
  }
}
