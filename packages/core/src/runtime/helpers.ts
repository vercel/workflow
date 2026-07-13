import { RUN_ERROR_CODES, WorkflowWorldError } from '@workflow/errors';
import type {
  Event,
  HealthCheckPayload,
  ValidQueueName,
  WorkflowRun,
  World,
} from '@workflow/world';
import {
  getQueueTopicPrefix,
  HealthCheckPayloadSchema,
  resolveQueueNamespace,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';

import { type CryptoKey, importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getSpanKind, trace } from '../telemetry.js';
import { version as workflowCoreVersion } from '../version.js';
import { getWorldLazy } from './get-world-lazy.js';

/** Default timeout for health checks in milliseconds */
const DEFAULT_HEALTH_CHECK_TIMEOUT = 30_000;

/**
 * Pattern for safe workflow names. Only allows alphanumeric characters,
 * underscores, hyphens, dots, forward slashes (for namespaced workflows),
 * and at signs (for scoped packages).
 */
const SAFE_WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9_\-./@]+$/;

/**
 * Validates a workflow name and returns the corresponding queue name.
 * Ensures the workflow name only contains safe characters before
 * interpolating it into the queue name string.
 */
export function getWorkflowQueueName(
  workflowName: string,
  namespace?: string
): ValidQueueName {
  if (!SAFE_WORKFLOW_NAME_PATTERN.test(workflowName)) {
    throw new Error(
      `Invalid workflow name "${workflowName}": must only contain alphanumeric characters, underscores, hyphens, dots, forward slashes, or at signs`
    );
  }
  const prefix = getQueueTopicPrefix(
    'workflow',
    resolveQueueNamespace(namespace)
  );
  return `${prefix}${workflowName}` as ValidQueueName;
}

const generateId = monotonicFactory();

/**
 * Returns the stream name for a health check with the given correlation ID.
 */
function getHealthCheckStreamName(correlationId: string): string {
  return `__health_check__${correlationId}`;
}

/**
 * Result of a health check operation.
 */
export interface HealthCheckResult {
  healthy: boolean;
  /** Error message if health check failed */
  error?: string;
  /** Latency if the health check was successful */
  latencyMs?: number;
  /** Spec version of the responding deployment */
  specVersion?: number;
  /**
   * `@workflow/core` version of the responding deployment, used for
   * capability detection (see `getRunCapabilities`). Omitted when the
   * responding deployment did not provide the field as a string —
   * for example, an older `@workflow/core` that predates this field,
   * or a non-JSON plain-text health response.
   */
  workflowCoreVersion?: string;
}

/**
 * Checks if the given message is a health check payload.
 * If so, returns the parsed payload. Otherwise returns undefined.
 */
export function parseHealthCheckPayload(
  message: unknown
): HealthCheckPayload | undefined {
  const result = HealthCheckPayloadSchema.safeParse(message);
  if (result.success) {
    return result.data;
  }
  return undefined;
}

/**
 * Generates a deterministic fake runId for health check streams.
 * Both the writer (handleHealthCheckMessage) and reader (healthCheck) derive
 * the same runId from the correlationId so that implementations that scope
 * stream reads by runId still work correctly.
 */
function generateHealthCheckRunId(correlationId: string): string {
  return `wrun_hc_${correlationId}`;
}

/**
 * Handles a health check message by writing the result to the world's stream.
 * The caller can listen to this stream to get the health check response.
 *
 * @param healthCheck - The parsed health check payload
 * @param endpoint - Which endpoint is responding ('workflow' or 'step')
 */
export async function handleHealthCheckMessage(
  healthCheck: HealthCheckPayload,
  endpoint: 'workflow' | 'step',
  worldSpecVersion?: number
): Promise<void> {
  const world = await getWorldLazy();
  const streamName = getHealthCheckStreamName(healthCheck.correlationId);
  const response = JSON.stringify({
    healthy: true,
    endpoint,
    correlationId: healthCheck.correlationId,
    specVersion: worldSpecVersion ?? SPEC_VERSION_CURRENT,
    workflowCoreVersion,
    timestamp: Date.now(),
  });
  // Use a deterministic fake runId derived from the correlationId so that
  // the reader side produces the same value.
  const fakeRunId = generateHealthCheckRunId(healthCheck.correlationId);
  await world.streams.write(fakeRunId, streamName, response);
  await world.streams.close(fakeRunId, streamName);
}

export type HealthCheckEndpoint = 'workflow' | 'step';

export interface HealthCheckOptions {
  /** Timeout in milliseconds to wait for health check response. Default: 30000 (30s) */
  timeout?: number;
  /** Deployment ID to send the health check to. Falls back to process.env.VERCEL_DEPLOYMENT_ID. */
  deploymentId?: string;
  /**
   * Queue namespace of the target deployment (e.g. `'eve'` for topics like
   * `__eve_wkf_workflow_*`). Falls back to `WORKFLOW_QUEUE_NAMESPACE` in the
   * calling process. Cross-context callers (e.g. the observability
   * dashboard) must pass the target deployment's namespace explicitly —
   * the env fallback resolves in the caller's process, and a message
   * published to a mismatched topic has no consumer, so the check would
   * always time out.
   */
  namespace?: string;
}

/**
 * Performs a health check by sending a message through the queue pipeline
 * and verifying it is processed by the specified endpoint.
 *
 * This function bypasses Deployment Protection on Vercel because it goes
 * through the queue infrastructure rather than direct HTTP.
 *
 * @param world - The World instance to use for the health check
 * @param endpoint - Which endpoint to health check: 'workflow' or 'step'
 * @param options - Optional configuration for the health check
 * @returns Promise resolving to health check result
 */
// Poll interval for health check retries (ms)
const HEALTH_CHECK_POLL_INTERVAL = 100;
// Per-read timeout to prevent blocking forever on local world's EventEmitter
// (which doesn't work across processes)
const HEALTH_CHECK_READ_TIMEOUT = 500;

/**
 * Read chunks from a stream with a timeout per read operation.
 * Returns { chunks, timedOut } where timedOut indicates if a read timed out.
 */
/**
 * Race a promise against a deadline. Rejects with a timeout error when the
 * deadline elapses first. Used to bound `world.streams.get()` inside the
 * health-check poll loop: some worlds hold that request open until the
 * stream has data (e.g. workflow-server holds unwritten streams open for
 * ~2 minutes), which would otherwise blow through the configured health
 * check timeout — the `while` condition is only re-checked between
 * iterations.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Operation timed out after ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readStreamWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  readTimeout: number
): Promise<{ chunks: Uint8Array[]; timedOut: boolean }> {
  const chunks: Uint8Array[] = [];
  let done = false;
  let timedOut = false;

  while (!done && !timedOut) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>(
      (resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve({ done: true, value: undefined });
        }, readTimeout)
    );

    const result = await Promise.race([readPromise, timeoutPromise]);
    done = result.done;
    if (result.value) chunks.push(result.value);
  }

  return { chunks, timedOut };
}

/**
 * Parse and validate a health check response from stream chunks.
 * Returns the parsed response or null if invalid.
 */
function parseHealthCheckResponse(chunks: Uint8Array[]): {
  healthy: boolean;
  specVersion?: number;
  workflowCoreVersion?: string;
} | null {
  if (chunks.length === 0) return null;

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const responseText = new TextDecoder().decode(combined);

  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    // Old deployments (specVersion < 3) return plain text like
    // 'Workflow SDK "..." endpoint is healthy'. Treat any non-empty
    // text response as a healthy deployment with unknown specVersion.
    if (responseText.length > 0) {
      return { healthy: true };
    }
    return null;
  }

  if (
    typeof response !== 'object' ||
    response === null ||
    !('healthy' in response) ||
    typeof (response as { healthy: unknown }).healthy !== 'boolean'
  ) {
    return null;
  }

  const r = response as Record<string, unknown>;
  const parsed: {
    healthy: boolean;
    specVersion?: number;
    workflowCoreVersion?: string;
  } = {
    healthy: r.healthy as boolean,
  };
  if (typeof r.specVersion === 'number') {
    parsed.specVersion = r.specVersion;
  }
  if (typeof r.workflowCoreVersion === 'string') {
    parsed.workflowCoreVersion = r.workflowCoreVersion;
  }
  return parsed;
}

export async function healthCheck(
  world: World,
  endpoint: HealthCheckEndpoint,
  options?: HealthCheckOptions
): Promise<HealthCheckResult> {
  const timeout = options?.timeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT;
  const correlationId = generateId();
  const streamName = getHealthCheckStreamName(correlationId);

  const queueName =
    `${getQueueTopicPrefix(endpoint, resolveQueueNamespace(options?.namespace))}health_check` as ValidQueueName;

  const startTime = Date.now();

  try {
    await world.queue(
      queueName,
      { __healthCheck: true, correlationId },
      {
        // Use JSON transport so the health check works against both
        // old (JSON-only) and new (dual) deployments.
        specVersion: SPEC_VERSION_LEGACY,
        deploymentId: options?.deploymentId,
      }
    );

    while (Date.now() - startTime < timeout) {
      try {
        const remainingMs = timeout - (Date.now() - startTime);
        const stream = await withDeadline(
          world.streams.get(
            generateHealthCheckRunId(correlationId),
            streamName
          ),
          remainingMs
        );
        const reader = stream.getReader();
        const { chunks, timedOut } = await readStreamWithTimeout(
          reader,
          HEALTH_CHECK_READ_TIMEOUT
        );

        if (timedOut) {
          try {
            reader.cancel();
          } catch {
            // Ignore cancel errors
          }
          await new Promise((resolve) =>
            setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL)
          );
          continue;
        }

        const response = parseHealthCheckResponse(chunks);
        if (response) {
          return {
            ...response,
            latencyMs: Date.now() - startTime,
          };
        }

        await new Promise((resolve) =>
          setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL)
        );
      } catch {
        await new Promise((resolve) =>
          setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL)
        );
      }
    }
    return {
      healthy: false,
      error: `Health check timed out after ${timeout}ms`,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function eventPaginationContractError(
  runId: string,
  message: string
): WorkflowWorldError {
  return new WorkflowWorldError(
    `Event pagination ${message} for workflow run "${runId}".`,
    { code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR }
  );
}

function recordRequestedEventCursor(
  runId: string,
  cursor: string | null,
  requestedCursors: Set<string>
): void {
  if (!cursor) {
    return;
  }
  if (requestedCursors.has(cursor)) {
    throw eventPaginationContractError(runId, 'did not advance');
  }
  requestedCursors.add(cursor);
}

function appendUniqueEvents(
  target: Event[],
  targetIds: Set<string>,
  events: Event[]
): void {
  for (const event of events) {
    if (!targetIds.has(event.eventId)) {
      targetIds.add(event.eventId);
      target.push(event);
    }
  }
}

function assertEventPaginationProgress(
  runId: string,
  hasMore: boolean,
  cursor: string | null,
  requestedCursors: Set<string>
): void {
  if (!hasMore) {
    return;
  }
  if (cursor === null) {
    throw eventPaginationContractError(
      runId,
      'returned more pages without a cursor'
    );
  }
  if (requestedCursors.has(cursor)) {
    throw eventPaginationContractError(runId, 'repeated a cursor');
  }
}

function shouldRetryWithoutEventCursor(
  error: unknown,
  cursor: string | null,
  alreadyRetried: boolean
): boolean {
  return (
    cursor !== null &&
    !alreadyRetried &&
    WorkflowWorldError.is(error) &&
    error.status === 400
  );
}

/**
 * Loads workflow run events by iterating through all pages of paginated
 * results. Events are returned in chronological (ascending) order for
 * deterministic workflow replay.
 *
 * @param runId - The workflow run ID.
 * @param afterCursor - If provided, only events after this cursor are
 *   returned (incremental load). If omitted, all events are returned.
 *   The returned cursor can be passed back in on a subsequent call for
 *   incremental loading.
 */
export async function loadWorkflowRunEvents(
  runId: string,
  afterCursor?: string
): Promise<{ events: Event[]; cursor: string | null }> {
  const incremental = afterCursor !== undefined;
  return trace(
    incremental ? 'workflow.loadNewEvents' : 'workflow.loadEvents',
    async (span) => {
      span?.setAttributes({
        ...Attribute.WorkflowRunId(runId),
      });

      const loadedEvents: Event[] = [];
      const loadedEventIds = new Set<string>();
      const requestedCursors = new Set<string>();
      let cursor: string | null = afterCursor ?? null;
      let hasMore = true;
      let pagesLoaded = 0;
      let retriedWithoutCursor = false;

      const world = await getWorldLazy();
      const loadStart = Date.now();
      while (hasMore) {
        // TODO: we're currently loading all the data with resolveRef behaviour. We need to update this
        // to lazyload the data from the world instead so that we can optimize and make the event log loading
        // much faster and memory efficient
        const pageStart = Date.now();
        const requestedCursor = cursor;
        recordRequestedEventCursor(runId, requestedCursor, requestedCursors);

        let response: Awaited<ReturnType<typeof world.events.list>>;
        try {
          response = await world.events.list({
            runId,
            pagination: {
              sortOrder: 'asc',
              cursor: requestedCursor ?? undefined,
            },
          });
        } catch (error) {
          if (
            shouldRetryWithoutEventCursor(
              error,
              requestedCursor,
              retriedWithoutCursor
            )
          ) {
            runtimeLogger.warn(
              'Event cursor was rejected; retrying with a full event reload.',
              { workflowRunId: runId }
            );
            loadedEvents.length = 0;
            loadedEventIds.clear();
            requestedCursors.clear();
            cursor = null;
            retriedWithoutCursor = true;
            continue;
          }
          throw error;
        }

        appendUniqueEvents(loadedEvents, loadedEventIds, response.data);
        hasMore = response.hasMore;
        assertEventPaginationProgress(
          runId,
          hasMore,
          response.cursor,
          requestedCursors
        );
        // Preserve the last non-null cursor across pages. A World may
        // legitimately return `{ data: [], cursor: null, hasMore: false }`
        // on a trailing empty page — for example when the previous page's
        // underlying DB query hit the limit exactly and returned a
        // `LastEvaluatedKey` "just in case". Overwriting with that null
        // would lose the position past the last real event we loaded and
        // force the runtime into the "no cursor after initial load" full-
        // reload fallback on every subsequent replay iteration.
        cursor = response.cursor ?? cursor;
        pagesLoaded++;

        runtimeLogger.debug('Loaded event page', {
          workflowRunId: runId,
          incremental,
          page: pagesLoaded,
          pageEvents: response.data.length,
          totalEvents: loadedEvents.length,
          hasMore,
          pageMs: Date.now() - pageStart,
        });
      }

      runtimeLogger.debug('Event load complete', {
        workflowRunId: runId,
        incremental,
        totalEvents: loadedEvents.length,
        pagesLoaded,
        totalMs: Date.now() - loadStart,
      });

      span?.setAttributes({
        ...Attribute.WorkflowEventsCount(loadedEvents.length),
        ...Attribute.WorkflowEventsPagesLoaded(pagesLoaded),
      });

      return { events: loadedEvents, cursor };
    }
  );
}

/**
 * CORS headers for health check responses.
 * Allows the observability UI to check endpoint health from a different origin.
 */
const HEALTH_CHECK_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Wraps a request/response handler and adds a health check "mode"
 * based on the presence of a `__health` query parameter.
 */
export function withHealthCheck(
  handler: (req: Request) => Promise<Response>,
  worldSpecVersion?: number
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const isHealthCheck = url.searchParams.has('__health');
    if (isHealthCheck) {
      // Handle CORS preflight for health check
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: HEALTH_CHECK_CORS_HEADERS,
        });
      }
      return new Response(
        JSON.stringify({
          healthy: true,
          endpoint: url.pathname,
          specVersion: worldSpecVersion ?? SPEC_VERSION_CURRENT,
          workflowCoreVersion,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...HEALTH_CHECK_CORS_HEADERS,
          },
        }
      );
    }
    return await handler(req);
  };
}

/**
 * Queues a message to the specified queue with tracing.
 */
export async function queueMessage(
  world: World,
  ...args: Parameters<typeof world.queue>
) {
  const queueName = args[0];
  await trace(
    'queue.publish',
    {
      // Standard OTEL messaging conventions
      attributes: {
        ...Attribute.MessagingSystem('vercel-queue'),
        ...Attribute.MessagingDestinationName(queueName),
        ...Attribute.MessagingOperationType('publish'),
        // Peer service for Datadog service maps
        ...Attribute.PeerService('vercel-queue'),
        ...Attribute.RpcSystem('vercel-queue'),
        ...Attribute.RpcService('vqs'),
        ...Attribute.RpcMethod('publish'),
      },
      kind: await getSpanKind('PRODUCER'),
    },
    async (span) => {
      const { messageId } = await world.queue(...args);
      if (messageId) {
        span?.setAttributes(Attribute.MessagingMessageId(messageId));
      }
    }
  );
}

/**
 * Calculates the queue overhead time in milliseconds for a given message.
 */
export function getQueueOverhead(message: { requestedAt?: Date }) {
  if (!message.requestedAt) return;
  try {
    return Attribute.QueueOverheadMs(
      Date.now() - message.requestedAt.getTime()
    );
  } catch {
    return;
  }
}

/**
 * Returns a memoized accessor for the per-run AES-256 encryption key.
 *
 * The first call resolves the key via `world.getEncryptionKeyForRun` (which
 * may do HKDF derivation locally on Vercel, or a network fetch from
 * external contexts) and imports it as a `CryptoKey`; subsequent calls
 * await the same cached promise. If the world doesn't support encryption
 * or the run has no key configured, the cached value is `undefined`.
 *
 * Used by step / workflow handlers to defer the (potentially expensive)
 * key fetch until the first code path that actually needs it — typically
 * input hydration on the success path, or error dehydration on a failure
 * path. Both paths can race-call the accessor without triggering duplicate
 * fetches.
 *
 * Errors thrown by `getEncryptionKeyForRun` propagate to every caller
 * (the cached promise rejects). This is intentional: when encryption is
 * configured, we never want to silently fall back to plaintext
 * serialization. A propagated error in an event-emission path leaves the
 * outer try/catch to log and surface the issue; the queue's redelivery
 * semantics will retry the key fetch on the next attempt.
 */
export function memoizeEncryptionKey(
  world: World,
  runOrId: WorkflowRun | string
): () => Promise<CryptoKey | undefined> {
  let cached: Promise<CryptoKey | undefined> | undefined;
  return () => {
    if (!cached) {
      cached = (async () => {
        // The `getEncryptionKeyForRun` overload set takes either a
        // `WorkflowRun` or a `runId: string` (with optional context). Branch
        // here so TypeScript picks the right overload for each shape.
        const rawKey =
          typeof runOrId === 'string'
            ? await world.getEncryptionKeyForRun?.(runOrId)
            : await world.getEncryptionKeyForRun?.(runOrId);
        return rawKey ? await importKey(rawKey) : undefined;
      })();
    }
    return cached;
  };
}
