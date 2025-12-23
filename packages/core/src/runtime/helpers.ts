import type { Event, World } from '@workflow/world';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getSpanKind, trace } from '../telemetry.js';
import { getWorld } from './world.js';

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
