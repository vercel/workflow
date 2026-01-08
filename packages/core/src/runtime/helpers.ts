import type {
  Event,
  HealthCheckPayload,
  ValidQueueName,
  World,
} from '@workflow/world';
import { HealthCheckPayloadSchema } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getSpanKind, trace } from '../telemetry.js';
import { getWorld } from './world.js';

/** Default timeout for health checks in milliseconds */
const DEFAULT_HEALTH_CHECK_TIMEOUT = 30_000;

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
  // Use the correlationId as the "runId" for streaming purposes
  // This is a bit of a hack but allows us to reuse the streaming infrastructure
  await world.writeToStream(streamName, healthCheck.correlationId, response);
  await world.closeStream(streamName, healthCheck.correlationId);
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
export async function healthCheck(
  world: World,
  endpoint: HealthCheckEndpoint,
  options?: HealthCheckOptions
): Promise<HealthCheckResult> {
  const timeout = options?.timeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT;
  const correlationId = `hc_${generateId()}`;
  const streamName = getHealthCheckStreamName(correlationId);

  // Determine which queue to use based on endpoint
  const queueName: ValidQueueName =
    endpoint === 'workflow'
      ? '__wkf_workflow_health_check'
      : '__wkf_step_health_check';

  try {
    // Wait for the response with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Health check timed out after ${timeout}ms`));
      }, timeout);
    });

    const readStreamResponse = async (): Promise<HealthCheckResult> => {
      // Read from the stream - the handler will write to this when it receives the health check
      const stream = await world.readFromStream(streamName);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];

      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) chunks.push(result.value);
      }

      // Parse the response
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
        throw new Error('Invalid health check response format');
      }

      // Type guard: ensure response has the expected structure
      if (
        typeof response !== 'object' ||
        response === null ||
        !('healthy' in response) ||
        typeof (response as { healthy: unknown }).healthy !== 'boolean'
      ) {
        throw new Error('Invalid health check response structure');
      }

      return {
        healthy: (response as { healthy: boolean }).healthy,
      };
    };

    // Start reading from stream BEFORE sending the queue message to avoid race condition
    const responsePromise = readStreamResponse();

    // Send the health check message through the queue
    await world.queue(queueName, {
      __healthCheck: true,
      correlationId,
    });

    return await Promise.race([responsePromise, timeoutPromise]);
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
  const allEvents: Event[] = [];
  let cursor: string | null = null;
  let hasMore = true;

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
  }

  return allEvents;
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
    'queueMessage',
    {
      attributes: Attribute.QueueName(queueName),
      kind: await getSpanKind('PRODUCER'),
    },
    async (span) => {
      const { messageId } = await world.queue(...args);
      span?.setAttributes(Attribute.QueueMessageId(messageId));
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
