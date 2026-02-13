import { WorkflowAPIError } from '@workflow/errors';
import type {
  Event,
  HealthCheckPayload,
  ValidQueueName,
  World,
} from '@workflow/world';
import { HealthCheckPayloadSchema } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { runtimeLogger } from '../logger.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getSpanKind, trace } from '../telemetry.js';
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
  endpoint: 'workflow' | 'step'
): Promise<void> {
  const world = getWorld();
  const streamName = getHealthCheckStreamName(healthCheck.correlationId);
  const response = JSON.stringify({
    healthy: true,
    endpoint,
    correlationId: healthCheck.correlationId,
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

  return { healthy: (response as { healthy: boolean }).healthy };
}

export async function healthCheck(
  world: World,
  endpoint: HealthCheckEndpoint,
  options?: HealthCheckOptions
): Promise<HealthCheckResult> {
  const timeout = options?.timeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT;
  const correlationId = `hc_${generateId()}`;
  const streamName = getHealthCheckStreamName(correlationId);

  const queueName: ValidQueueName =
    endpoint === 'workflow'
      ? '__wkf_workflow_health_check'
      : '__wkf_step_health_check';

  const startTime = Date.now();

  try {
    await world.queue(queueName, {
      __healthCheck: true,
      correlationId,
    });

    while (Date.now() - startTime < timeout) {
      try {
        const stream = await world.readFromStream(streamName);
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

    const world = getWorld();
    while (hasMore) {
      // TODO: we're currently loading all the data with resolveRef behaviour. We need to update this
      // to lazyload the data from the world instead so that we can optimize and make the event log loading
      // much faster and memory efficient
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
    }

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
  handler: (req: Request) => Promise<Response>
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
        `Workflow DevKit "${url.pathname}" endpoint is healthy`,
        {
          status: 200,
          headers: {
            'Content-Type': 'text/plain',
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
      span?.setAttributes(Attribute.MessagingMessageId(messageId));
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
 * Wraps a queue handler with HTTP 429 throttle retry logic.
 * - retryAfter < 10s: waits in-process via setTimeout, then retries once
 * - retryAfter >= 10s: returns { timeoutSeconds } to defer to the queue
 *
 * Safe to retry the entire handler because 429 is sent from server middleware
 * before the request is processed — no server state has changed.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: matches Queue handler return type
export async function withThrottleRetry(
  fn: () => Promise<void | { timeoutSeconds: number }>
): Promise<void | { timeoutSeconds: number }> {
  try {
    return await fn();
  } catch (err) {
    if (WorkflowAPIError.is(err) && err.status === 429) {
      const retryAfterSeconds = Math.max(
        // If we don't have a retry-after value, 30s seems a reasonable default
        // to avoid re-trying during the unknown rate-limiting period.
        1,
        typeof err.retryAfter === 'number' ? err.retryAfter : 30
      );

      if (retryAfterSeconds < 10) {
        runtimeLogger.warn(
          'Throttled by workflow-server (429), retrying in-process',
          {
            retryAfterSeconds,
            url: err.url,
          }
        );
        // Short wait: sleep in-process, then retry once
        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000)
        );
        try {
          return await fn();
        } catch (retryErr) {
          // If the retry also gets throttled, defer to queue
          if (WorkflowAPIError.is(retryErr) && retryErr.status === 429) {
            const retryRetryAfter = Math.max(
              1,
              typeof retryErr.retryAfter === 'number' ? retryErr.retryAfter : 1
            );
            runtimeLogger.warn('Throttled again on retry, deferring to queue', {
              retryAfterSeconds: retryRetryAfter,
            });
            return { timeoutSeconds: retryRetryAfter };
          }
          throw retryErr;
        }
      }

      // Long wait: defer to queue infrastructure
      runtimeLogger.warn(
        'Throttled by workflow-server (429), deferring to queue',
        {
          retryAfterSeconds,
          url: err.url,
        }
      );
      return { timeoutSeconds: retryAfterSeconds };
    }
    throw err;
  }
}

/**
 * Retries a function when it throws a 5xx WorkflowAPIError.
 * Used to handle transient workflow-server errors without consuming step attempts.
 *
 * Retries up to 3 times with exponential backoff (500ms, 1s, 2s ≈ 3.5s total).
 * If all retries fail, the original error is re-thrown.
 */
export async function withServerErrorRetry<T>(
  fn: () => Promise<T>
): Promise<T> {
  const delays = [500, 1000, 2000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (
        WorkflowAPIError.is(err) &&
        err.status !== undefined &&
        err.status >= 500 &&
        attempt < delays.length
      ) {
        runtimeLogger.warn(
          'Server error (5xx) from workflow-server, retrying in-process',
          {
            status: err.status,
            attempt: attempt + 1,
            maxRetries: delays.length,
            nextDelayMs: delays[attempt],
            url: err.url,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw new Error('withServerErrorRetry: unreachable');
}
