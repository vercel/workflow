import type {
  Event,
  HealthCheckPayload,
  ValidQueueName,
  World,
} from '@workflow/world';
import {
  HealthCheckPayloadSchema,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
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
export function getWorkflowQueueName(workflowName: string): ValidQueueName {
  if (!SAFE_WORKFLOW_NAME_PATTERN.test(workflowName)) {
    throw new Error(
      `Invalid workflow name "${workflowName}": must only contain alphanumeric characters, underscores, hyphens, dots, forward slashes, or at signs`
    );
  }
  return `__wkf_workflow_${workflowName}` as ValidQueueName;
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
  const world = await getWorld();
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
function parseHealthCheckResponse(
  chunks: Uint8Array[]
): { healthy: boolean } | null {
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
  const parsed: { healthy: boolean; specVersion?: number } = {
    healthy: r.healthy as boolean,
  };
  if (typeof r.specVersion === 'number') {
    parsed.specVersion = r.specVersion;
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

  const queueName: ValidQueueName =
    endpoint === 'workflow'
      ? '__wkf_workflow_health_check'
      : '__wkf_step_health_check';

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
        const stream = await world.streams.get(
          generateHealthCheckRunId(correlationId),
          streamName
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

/**
 * Loads all workflow run events by iterating through all pages of paginated results.
 * This ensures that *all* events are loaded into memory before running the workflow.
 * Events must be in chronological order (ascending) for proper workflow replay.
 */
export async function getAllWorkflowRunEvents(runId: string): Promise<Event[]> {
  return trace('workflow.loadEvents', async (span) => {
    span?.setAttributes({
      ...Attribute.WorkflowRunId(runId),
    });

    const allEvents: Event[] = [];
    let cursor: string | null = null;
    let hasMore = true;
    let pagesLoaded = 0;

    const world = await getWorld();
    const loadStart = Date.now();
    while (hasMore) {
      // TODO: we're currently loading all the data with resolveRef behaviour. We need to update this
      // to lazyload the data from the world instead so that we can optimize and make the event log loading
      // much faster and memory efficient
      const pageStart = Date.now();
      const response = await world.events.list({
        runId,
        pagination: {
          sortOrder: 'asc', // Required: events must be in chronological order for replay
          cursor: cursor ?? undefined,
        },
      });

      allEvents.push(...response.data);
      hasMore = response.hasMore;
      cursor = response.cursor;
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

    return allEvents;
  });
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
