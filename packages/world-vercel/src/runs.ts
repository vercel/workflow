import { WorkflowRunNotFoundError, WorkflowWorldError } from '@workflow/errors';
import {
  type AttributeChange,
  type BulkCancelWorkflowRunsRequest,
  BulkCancelWorkflowRunsRequestSchema,
  type BulkCancelWorkflowRunsResult,
  BulkCancelWorkflowRunsResultSchema,
  type CancelWorkflowRunParams,
  type CreateWorkflowRunRequest,
  type ExperimentalSetAttributesResult,
  type GetWorkflowRunParams,
  type ListWorkflowRunsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  SerializedDataSchema,
  type WaitForTerminalRunStatusParams,
  type WorkflowRun,
  WorkflowRunBaseSchema,
  type WorkflowRunWithoutData,
} from '@workflow/world';
import { z } from 'zod';
import { getRequestTimeoutMs } from './http-core.js';
import { normalizeWorkflowRunData } from './serialized-data.js';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  deserializeError,
  getHttpUrl,
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

// Implementation. This is a read/display entry point (getRun/listRuns),
// so it decompresses gzip/zstd payload wrappers via
// `normalizeWorkflowRunData`. The runtime write path (events.create)
// re-hydrates run errors through `hydrateRunError`, which decompresses
// on its own, so it deliberately does not route through here.
function filterRunData(
  run: any,
  resolveData: 'none' | 'all'
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === 'none') {
    const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = run;
    const deserialized = normalizeWorkflowRunData(
      deserializeError<WorkflowRun>(rest) as unknown as Record<string, unknown>
    );
    return {
      ...deserialized,
      input: undefined,
      output: undefined,
    } as WorkflowRunWithoutData;
  }
  return normalizeWorkflowRunData(
    deserializeError<WorkflowRun>(run) as unknown as Record<string, unknown>
  ) as unknown as WorkflowRun;
}

// Functions

/**
 * Lists canonical workflow storage records.
 *
 * Observability and inspection usage is deprecated: use
 * `world.analytics.runs.list()` for plan-aware, ClickHouse-backed queries.
 * This path remains for operational and payload-bearing callers.
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

  try {
    return await readRun(id, { resolveData }, config);
  } catch (error) {
    if (error instanceof WorkflowWorldError && error.status === 404) {
      throw new WorkflowRunNotFoundError(id);
    }
    throw error;
  }
}

/**
 * Issue one run read against workflow-server and normalize it into the World's
 * `WorkflowRun` shape.
 *
 * `waitMs`, when set, targets the long-pollable `GET /v2/runs/:runId/status`
 * route instead of the plain read: same entity, same errors, but the server
 * holds the request open until the run reaches a terminal status or the budget
 * expires. Shared by `getWorkflowRun` and `waitForWorkflowRunTerminalStatus` so
 * the two can never drift in how they parse or filter a run.
 */
async function readRun(
  id: string,
  params: {
    resolveData: 'none' | 'all';
    waitMs?: number;
    signal?: AbortSignal;
  },
  config?: APIConfig
): Promise<WorkflowRun | WorkflowRunWithoutData> {
  const { resolveData, waitMs, signal } = params;
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';

  const searchParams = new URLSearchParams();
  searchParams.set('remoteRefBehavior', remoteRefBehavior);
  if (waitMs !== undefined) searchParams.set('waitMs', String(waitMs));

  const path = waitMs === undefined ? '' : '/status';
  const queryString = searchParams.toString();
  const endpoint = `/v2/runs/${encodeURIComponent(id)}${path}${queryString ? `?${queryString}` : ''}`;

  const run = await makeRequest({
    endpoint,
    options: { method: 'GET', ...(signal ? { signal } : {}) },
    config,
    retryConnectTimeout: true,
    ...(waitMs !== undefined ? { transport: 'run-status' as const } : {}),
    schema: (remoteRefBehavior === 'lazy'
      ? WorkflowRunWireWithRefsSchema
      : WorkflowRunWireSchema) as any,
  });

  return filterRunData(run, resolveData);
}

/**
 * Headroom kept between the wait budget we ask the server to hold and the
 * adapter's own per-request HTTP timeout. The budget must always expire as a
 * *response* (a non-terminal run) rather than as a client-side timeout: a
 * timeout is indistinguishable from a broken backend and would turn a healthy
 * wait into retry noise.
 */
const WAIT_TIMEOUT_HEADROOM_MS = 10_000;

/**
 * How long a `404`/`405`/`501` on the long-poll route suppresses further
 * attempts before the next one re-probes.
 *
 * A miss means the backend serving this base URL predates the route (or has it
 * rolled back), which is a property of the *backend*, not of the run — so it is
 * cached rather than re-learned per call. It expires so a client that outlives
 * a server roll-forward picks the fast path back up on its own.
 */
const LONG_POLL_UNSUPPORTED_TTL_MS = 5 * 60 * 1000;

/**
 * Suppression deadline per base URL, because one process can hold worlds
 * pointed at different backends — the api.vercel.com proxy (with
 * `projectConfig`) and workflow-server directly resolve to different hosts,
 * which can be on different versions. A miss against one must not disable the
 * fast path for the other. Bounded by construction: the key is the resolved
 * base URL, of which a process has a handful at most.
 */
const longPollUnsupportedUntilByBaseUrl = new Map<string, number>();

/** Test-only: forget that the long-poll route was unavailable. @internal */
export function _resetRunStatusLongPollSupportForTests(): void {
  longPollUnsupportedUntilByBaseUrl.clear();
}

/**
 * Whether this failure means "the long poll is not usable against this
 * backend", as opposed to something the caller needs to see.
 *
 * Two shapes, for the same reason: the answer we want is a plain read either
 * way, and the fast path should stand down until it re-probes.
 *
 * - **The route is missing** (`404`/`405`/`501`). `404` is ambiguous — the run
 *   may not exist — which the plain read below disambiguates.
 * - **The hold did not survive** — the request timed out client-side
 *   (`TIMEOUT`), the connection was severed mid-hold (`TRANSPORT`), or an
 *   intermediary gave up on it (`504`). Holding a request open for ~25s is a
 *   new shape for this client, and it crosses gateways and egress proxies that
 *   are entitled to cut an apparently idle connection. None of that means the
 *   run is in trouble, so it must not surface as a failed `run.returnValue`:
 *   without this, a healthy still-running run hard-fails the caller's await,
 *   and does so on every retry, since nothing would mark the route unusable.
 *
 * A plain `500`/`502`/`503` still propagates. Those say the backend itself is
 * unwell rather than that this *route* cannot be held open, and masking them
 * behind a second read would hide a real outage. `RetryAgent` has already
 * retried them in-process by the time they reach here.
 */
function isLongPollUnusable(error: WorkflowWorldError): boolean {
  if (error.status === 404 || error.status === 405 || error.status === 501) {
    return true;
  }
  if (error.status === 504) return true;
  // Set by makeRequest/instrumentedFetch; both carry no HTTP status, because
  // no response ever arrived.
  return (
    error.status === undefined &&
    (error.code === 'TIMEOUT' || error.code === 'TRANSPORT')
  );
}

/**
 * Wait for a run to reach a terminal status, using workflow-server's
 * long-pollable `GET /v2/runs/:runId/status` route.
 *
 * Implements `Storage['runs'].waitForTerminalStatus`: resolves as soon as the
 * run is terminal, and otherwise with the latest snapshot once the budget
 * expires. Never throws on a timeout — a still-running run is an answer.
 *
 * Degrades in two places, because the adapter can outlive the server version
 * it was built against:
 *
 * - **Budget.** Clamped to leave {@link WAIT_TIMEOUT_HEADROOM_MS} under the
 *   adapter's per-request timeout, and the server clamps again to its own
 *   ceiling. A budget that clamps to zero is just a plain read.
 * - **Missing route.** A `404` is ambiguous — the run may not exist, or this
 *   server may not have the route — so it is resolved by falling back to the
 *   plain read, which is the answer we want either way: it raises
 *   `WorkflowRunNotFoundError` for a missing run, and returns the run when the
 *   *route* was what was missing. Only the latter (proof that the run exists
 *   and the route does not) suppresses the fast path, and only for the base URL
 *   that answered, so neither one bad run ID nor one lagging backend can
 *   disable long polling everywhere.
 */
export async function waitForWorkflowRunTerminalStatus(
  id: string,
  params: WaitForTerminalRunStatusParams & { resolveData: 'none' },
  config?: APIConfig
): Promise<WorkflowRunWithoutData>;
export async function waitForWorkflowRunTerminalStatus(
  id: string,
  params?: WaitForTerminalRunStatusParams & { resolveData?: 'all' },
  config?: APIConfig
): Promise<WorkflowRun>;
export async function waitForWorkflowRunTerminalStatus(
  id: string,
  params?: WaitForTerminalRunStatusParams,
  config?: APIConfig
): Promise<WorkflowRun | WorkflowRunWithoutData>;
export async function waitForWorkflowRunTerminalStatus(
  id: string,
  params?: WaitForTerminalRunStatusParams,
  config?: APIConfig
): Promise<WorkflowRun | WorkflowRunWithoutData> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const waitMs = Math.max(
    0,
    Math.min(
      params?.timeoutMs ?? 0,
      getRequestTimeoutMs() - WAIT_TIMEOUT_HEADROOM_MS
    )
  );

  const { baseUrl } = getHttpUrl(config);
  const unsupportedUntil = longPollUnsupportedUntilByBaseUrl.get(baseUrl) ?? 0;

  if (waitMs === 0 || Date.now() < unsupportedUntil) {
    return getWorkflowRun(id, { resolveData }, config);
  }

  try {
    return await readRun(
      id,
      {
        resolveData,
        waitMs,
        ...(params?.signal ? { signal: params.signal } : {}),
      },
      config
    );
  } catch (error) {
    // The caller cancelled on purpose. That is not a verdict on the route, so
    // it propagates rather than degrading — otherwise an ordinary abort would
    // both cost an extra read and switch the fast path off for every run in
    // this process. Checked first because an abort surfaces with the same
    // `TIMEOUT` code as a request that ran out of time on its own.
    if (params?.signal?.aborted) {
      throw error;
    }
    if (!(error instanceof WorkflowWorldError) || !isLongPollUnusable(error)) {
      throw error;
    }

    // Throws WorkflowRunNotFoundError when the run is what was missing.
    const run = await getWorkflowRun(id, { resolveData }, config);
    longPollUnsupportedUntilByBaseUrl.set(
      baseUrl,
      Date.now() + LONG_POLL_UNSUPPORTED_TTL_MS
    );
    return run;
  }
}

/**
 * Retrieves a snapshot for each requested run ID. Delegates to
 * `getWorkflowRun` for each ID and returns null for IDs that do not exist.
 */
export async function getWorkflowRuns(
  ids: readonly string[],
  params: GetWorkflowRunParams & { resolveData: 'none' },
  config?: APIConfig
): Promise<(WorkflowRunWithoutData | null)[]>;
export async function getWorkflowRuns(
  ids: readonly string[],
  params?: GetWorkflowRunParams & { resolveData?: 'all' },
  config?: APIConfig
): Promise<(WorkflowRun | null)[]>;
export async function getWorkflowRuns(
  ids: readonly string[],
  params?: GetWorkflowRunParams,
  config?: APIConfig
): Promise<(WorkflowRun | WorkflowRunWithoutData | null)[]>;
export async function getWorkflowRuns(
  ids: readonly string[],
  params?: GetWorkflowRunParams,
  config?: APIConfig
): Promise<(WorkflowRun | WorkflowRunWithoutData | null)[]> {
  const uniqueIds = [...new Set(ids)];
  const runs = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        return await getWorkflowRun(id, params, config);
      } catch (error) {
        if (error instanceof WorkflowRunNotFoundError) {
          return null;
        }
        throw error;
      }
    })
  );
  const runById = new Map(uniqueIds.map((id, i) => [id, runs[i]]));
  return ids.map((id) => runById.get(id) ?? null);
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
 * Cancel many runs in a single backend request.
 *
 * The request is validated client-side (1–500 unique IDs) before hitting
 * `POST /v4/runs/cancel`, and the structured response is parsed with the
 * shared world schema. Results are reordered to match the requested
 * `runIds` so callers get a stable, request-aligned array regardless of
 * the order the backend returns.
 */
export async function cancelWorkflowRuns(
  request: BulkCancelWorkflowRunsRequest,
  config?: APIConfig
): Promise<BulkCancelWorkflowRunsResult> {
  const { runIds, cancelReason } =
    BulkCancelWorkflowRunsRequestSchema.parse(request);

  const response = await makeRequest({
    endpoint: '/v4/runs/cancel',
    options: { method: 'POST' },
    data: cancelReason !== undefined ? { runIds, cancelReason } : { runIds },
    config,
    schema: BulkCancelWorkflowRunsResultSchema,
  });

  // The backend must return exactly one result per requested ID. A missing
  // ID, a duplicate, or an unexpected extra ID is a protocol violation:
  // reject it rather than papering over it by synthesizing a `not_found`
  // outcome, which would silently disagree with the backend's own summary.
  const resultByRunId = new Map(
    response.results.map((result) => [result.runId, result])
  );
  const isBijection =
    resultByRunId.size === response.results.length &&
    response.results.length === runIds.length &&
    runIds.every((runId) => resultByRunId.has(runId));
  if (!isBijection) {
    throw new WorkflowWorldError(
      `Bulk cancel response did not contain exactly one result per requested run ID ` +
        `(requested ${runIds.length}, received ${response.results.length}).`
    );
  }

  const orderedResults = runIds.map(
    (runId) => resultByRunId.get(runId) as (typeof response.results)[number]
  );

  return { summary: response.summary, results: orderedResults };
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
