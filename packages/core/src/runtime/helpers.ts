import {
  PreconditionFailedError,
  RUN_ERROR_CODES,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  Event,
  HealthCheckPayload,
  ValidQueueName,
  World,
} from '@workflow/world';
import {
  getQueueTopicPrefix,
  HealthCheckPayloadSchema,
  resolveQueueNamespace,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  ulidToDate,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';

import { runtimeLogger } from '../logger.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getSpanKind, trace } from '../telemetry.js';
import { version as workflowCoreVersion } from '../version.js';
import { getWorld } from './world.js';

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
 * Generates a fake runId for health check streams.
 * This runId passes server validation but is not associated with a real run.
 * The server skips run validation for streams starting with `__health_check__`.
 */
function generateHealthCheckRunId(): string {
  return `wrun_${generateId()}`;
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
  const world = getWorld();
  const streamName = getHealthCheckStreamName(healthCheck.correlationId);
  const response = JSON.stringify({
    healthy: true,
    endpoint,
    correlationId: healthCheck.correlationId,
    specVersion: worldSpecVersion ?? SPEC_VERSION_CURRENT,
    workflowCoreVersion,
    timestamp: Date.now(),
  });
  // Use a fake runId that passes validation.
  // The stream name includes the correlationId for identification.
  // The server skips run validation for health check streams.
  const fakeRunId = generateHealthCheckRunId();
  await world.writeToStream(streamName, fakeRunId, response);
  await world.closeStream(streamName, fakeRunId);
}

export type HealthCheckEndpoint = 'workflow' | 'step';

export interface HealthCheckOptions {
  /** Timeout in milliseconds to wait for health check response. Default: 30000 (30s) */
  timeout?: number;
  /** Deployment ID to send the health check to. Falls back to process.env.VERCEL_DEPLOYMENT_ID. */
  deploymentId?: string;
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

class HealthCheckTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Health check timed out after ${timeout}ms`);
  }
}

function getHealthCheckTimeRemaining(startTime: number, timeout: number) {
  return timeout - (Date.now() - startTime);
}

async function withHealthCheckTimeout<T>(
  promise: Promise<T>,
  startTime: number,
  timeout: number
): Promise<T> {
  const remaining = getHealthCheckTimeRemaining(startTime, timeout);
  if (remaining <= 0) {
    throw new HealthCheckTimeoutError(timeout);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new HealthCheckTimeoutError(timeout)),
          remaining
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNextHealthCheckPoll(startTime: number, timeout: number) {
  const remaining = getHealthCheckTimeRemaining(startTime, timeout);
  if (remaining <= 0) {
    return;
  }
  await wait(Math.min(HEALTH_CHECK_POLL_INTERVAL, remaining));
}

/**
 * Read chunks from a stream with a timeout per read operation.
 * Returns { chunks, timedOut } where timedOut indicates if a read timed out.
 */
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

async function readHealthCheckResponse(
  world: World,
  streamName: string,
  startTime: number,
  timeout: number
): Promise<{
  healthy: boolean;
  specVersion?: number;
  workflowCoreVersion?: string;
} | null> {
  const stream = await withHealthCheckTimeout(
    world.readFromStream(streamName),
    startTime,
    timeout
  );
  const reader = stream.getReader();
  const readTimeout = Math.min(
    HEALTH_CHECK_READ_TIMEOUT,
    Math.max(1, getHealthCheckTimeRemaining(startTime, timeout))
  );
  const { chunks, timedOut } = await readStreamWithTimeout(reader, readTimeout);

  if (timedOut) {
    await reader.cancel().catch(() => {});
    return null;
  }

  return parseHealthCheckResponse(chunks);
}

export async function healthCheck(
  world: World,
  endpoint: HealthCheckEndpoint,
  options?: HealthCheckOptions & { namespace?: string }
): Promise<HealthCheckResult> {
  const timeout = options?.timeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT;
  const correlationId = generateId();
  const streamName = getHealthCheckStreamName(correlationId);

  const queueName =
    `${getQueueTopicPrefix(endpoint, resolveQueueNamespace(options?.namespace))}health_check` as ValidQueueName;

  const startTime = Date.now();

  try {
    await withHealthCheckTimeout(
      world.queue(
        queueName,
        { __healthCheck: true, correlationId },
        {
          // Use JSON transport so the health check works against both
          // old (JSON-only) and new (dual) deployments.
          specVersion: SPEC_VERSION_LEGACY,
          deploymentId: options?.deploymentId,
        }
      ),
      startTime,
      timeout
    );

    while (getHealthCheckTimeRemaining(startTime, timeout) > 0) {
      try {
        const response = await readHealthCheckResponse(
          world,
          streamName,
          startTime,
          timeout
        );
        if (response) {
          return {
            ...response,
            latencyMs: Date.now() - startTime,
          };
        }
      } catch (error) {
        if (error instanceof HealthCheckTimeoutError) {
          throw error;
        }
      }
      await waitForNextHealthCheckPoll(startTime, timeout);
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

export interface LoadedWorkflowRunEvents {
  events: Event[];
  cursor: string | null;
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
 * Loads workflow run events by iterating through all pages of paginated results.
 * When a cursor is provided, only events after that cursor are loaded.
 * Events must be in chronological order (ascending) for proper workflow replay.
 */
export async function getWorkflowRunEvents(
  runId: string,
  cursor?: string
): Promise<LoadedWorkflowRunEvents> {
  return trace('workflow.loadEvents', async (span) => {
    span?.setAttributes({
      ...Attribute.WorkflowRunId(runId),
    });

    const allEvents: Event[] = [];
    const loadedEventIds = new Set<string>();
    const requestedCursors = new Set<string>();
    let nextCursor: string | null = cursor ?? null;
    let hasMore = true;
    let pagesLoaded = 0;
    let retriedWithoutCursor = false;

    const world = getWorld();
    const loadStart = Date.now();
    while (hasMore) {
      // TODO: we're currently loading all the data with resolveRef behaviour. We need to update this
      // to lazyload the data from the world instead so that we can optimize and make the event log loading
      // much faster and memory efficient
      const pageStart = Date.now();
      const requestedCursor = nextCursor;
      if (requestedCursor) {
        requestedCursors.add(requestedCursor);
      }

      let response: Awaited<ReturnType<typeof world.events.list>>;
      try {
        response = await world.events.list({
          runId,
          pagination: {
            sortOrder: 'asc', // Required: events must be in chronological order for replay
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
          allEvents.length = 0;
          loadedEventIds.clear();
          requestedCursors.clear();
          nextCursor = null;
          retriedWithoutCursor = true;
          continue;
        }
        throw error;
      }

      appendUniqueEvents(allEvents, loadedEventIds, response.data);
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
      // underlying DynamoDB query hit `Limit` exactly and returned a
      // `LastEvaluatedKey` "just in case". Overwriting with that null
      // would lose the position past the last real event we loaded and
      // force the runtime into the "no cursor after initial load" full-
      // reload fallback on every subsequent replay iteration.
      nextCursor = response.cursor ?? nextCursor;
      pagesLoaded++;

      runtimeLogger.debug('Loaded event page', {
        workflowRunId: runId,
        page: pagesLoaded,
        pageEvents: response.data.length,
        totalEvents: allEvents.length,
        hasMore,
        pageMs: Date.now() - pageStart,
      });
    }

    runtimeLogger.debug('Event loading complete', {
      workflowRunId: runId,
      totalEvents: allEvents.length,
      pagesLoaded,
      totalMs: Date.now() - loadStart,
    });

    span?.setAttributes({
      ...Attribute.WorkflowEventsCount(allEvents.length),
      ...Attribute.WorkflowEventsPagesLoaded(pagesLoaded),
    });

    return { events: allEvents, cursor: nextCursor };
  });
}

/**
 * Loads all workflow run events by iterating through all pages of paginated results.
 * This ensures that *all* events are loaded into memory before running the workflow.
 * Events must be in chronological order (ascending) for proper workflow replay.
 */
export async function getAllWorkflowRunEvents(runId: string): Promise<Event[]> {
  const { events } = await getWorkflowRunEvents(runId);
  return events;
}

/**
 * Maximum number of times a replay-context event creation will reload the
 * event log and retry after the backend rejects it as stale (412). After this
 * many failed reloads the precondition error propagates so the run is
 * re-invoked from the queue with a fresh replay.
 */
export const PRECONDITION_MAX_RELOAD_RETRIES = 2;

/**
 * A mutable view of the runtime's in-memory event log. `withPreconditionRetry`
 * appends freshly-loaded events to `events` (in place) and advances `cursor`
 * when it reloads, so the caller's loaded snapshot stays current.
 */
export interface MutableEventLog {
  events: Event[];
  cursor: string | null;
}

/**
 * Whether the optimistic-concurrency guard for event creation is enabled.
 * **On by default** where the runtime executes: replay-context creates send a
 * `stateUpdatedAt` snapshot (and can be rejected with 412 by a supporting
 * backend) unless `WORKFLOW_PRECONDITION_GUARD` is set to `0`. Backends without
 * guard support ignore the snapshot, so enabling by default is
 * backward-compatible.
 */
export function isPreconditionGuardEnabled(): boolean {
  return process.env.WORKFLOW_PRECONDITION_GUARD !== '0';
}

/**
 * The `stateUpdatedAt` value to send with a replay-context event creation: the
 * ULID time (epoch ms) of the latest event the runtime has loaded. Events are
 * stored in ascending order, so the last one is the newest. Returns `undefined`
 * when there are no events or the latest id is not a decodable ULID.
 *
 * Granularity: snapshots are epoch-milliseconds, and the backend allows an
 * equal-timestamp snapshot (an up-to-date client must not be rejected). Two
 * out-of-band events landing in the same millisecond where only the first was
 * loaded therefore pass the guard undetected — the guard is best-effort by
 * design, and fails open rather than livelocking.
 */
export function latestEventStateUpdatedAt(events: Event[]): number | undefined {
  const last = events[events.length - 1];
  if (!last) {
    return undefined;
  }
  // Event IDs are prefixed ULIDs (e.g. `evnt_01ARYZ...`); ulidToDate only
  // decodes the bare 26-char ULID, so strip the prefix first.
  const eventId = last.eventId;
  const underscore = eventId.lastIndexOf('_');
  const rawUlid = underscore === -1 ? eventId : eventId.slice(underscore + 1);
  const time = ulidToDate(rawUlid)?.getTime();
  if (time === undefined) {
    // Fail open: a non-decodable id disarms the guard for this create (no
    // snapshot sent). Log so a fleet-wide silent disarm is diagnosable.
    runtimeLogger.debug(
      'Precondition guard: latest event id is not a decodable ULID; sending no snapshot',
      { eventId }
    );
    return undefined;
  }
  return time;
}

/**
 * The `stateUpdatedAt` to attach to a replay-context event creation:
 * the loaded snapshot's ULID time when the precondition guard is enabled,
 * `undefined` (no guard, backend behaves as before) otherwise.
 */
export function stateUpdatedAtForCreate(events: Event[]): number | undefined {
  return isPreconditionGuardEnabled()
    ? latestEventStateUpdatedAt(events)
    : undefined;
}

/**
 * Runs a replay-context event creation with the optimistic-concurrency guard.
 *
 * `op` receives the current `stateUpdatedAt` (the ULID time of the latest
 * loaded event) to pass to `world.events.create`. If the backend rejects the
 * creation as stale (`PreconditionFailedError` / 412), the event log is
 * reloaded to completion from the last cursor, merged into `log` in place, and
 * `op` is retried with the now-newer snapshot — up to
 * `PRECONDITION_MAX_RELOAD_RETRIES` times. If it still fails, the error is
 * rethrown so the run falls back to a queue re-invocation. Non-precondition
 * errors are rethrown immediately.
 */
export async function withPreconditionRetry<T>(
  runId: string,
  log: MutableEventLog,
  op: (stateUpdatedAt: number | undefined) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op(stateUpdatedAtForCreate(log.events));
    } catch (error) {
      if (
        !PreconditionFailedError.is(error) ||
        attempt >= PRECONDITION_MAX_RELOAD_RETRIES
      ) {
        throw error;
      }
      runtimeLogger.info(
        'Event creation rejected as stale; reloading event log and retrying',
        {
          workflowRunId: runId,
          attempt: attempt + 1,
          maxRetries: PRECONDITION_MAX_RELOAD_RETRIES,
        }
      );
      const loaded = await getWorkflowRunEvents(runId, log.cursor ?? undefined);
      appendUniqueEvents(
        log.events,
        new Set(log.events.map((e) => e.eventId)),
        loaded.events
      );
      // When several creates share one `log` (e.g. hook creations under
      // `Promise.all` in `handleSuspension`), concurrent 412s can reload
      // concurrently. The event merge above is safe — `appendUniqueEvents`
      // builds its dedup set synchronously right before appending — but this
      // cursor write is last-write-wins, so an interleaved older reload can
      // briefly regress the cursor. The only consequence is refetching a few
      // already-deduped events on a later load; correctness is unaffected.
      log.cursor = loaded.cursor ?? log.cursor;
    }
  }
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
      if (req.method === 'HEAD') {
        return new Response(null, {
          status: 200,
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
