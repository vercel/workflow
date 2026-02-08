import { WorkflowAPIError } from '@workflow/errors';
import {
  type Event,
  isLegacySpecVersion,
  SPEC_VERSION_LEGACY,
  type World,
} from '@workflow/world';
import { hydrateWorkflowArguments } from '../serialization.js';
import { getWorkflowQueueName } from './helpers.js';
import { start } from './start.js';

export interface RecreateRunOptions {
  deploymentId?: string;
  specVersion?: number;
}

export interface StopSleepResult {
  /** Number of pending sleeps that were stopped */
  stoppedCount: number;
}

export interface ReadStreamOptions {
  /**
   * The index to start reading from. Defaults to 0.
   */
  startIndex?: number;
}

export interface StopSleepOptions {
  /**
   * Optional list of specific correlation IDs to target.
   * If provided, only these sleep calls will be interrupted.
   * If not provided, all pending sleep calls will be interrupted.
   */
  correlationIds?: string[];
}

const normalizeWorkflowArgs = (args: unknown): unknown[] => {
  return Array.isArray(args) ? args : [args];
};

/**
 * Start a new workflow run based on an existing run.
 */
export async function recreateRunFromExisting(
  world: World,
  runId: string,
  options: RecreateRunOptions = {}
): Promise<string> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'all' });
    const workflowArgs = normalizeWorkflowArgs(
      await hydrateWorkflowArguments(run.input, globalThis)
    );
    const specVersion =
      options.specVersion ?? run.specVersion ?? SPEC_VERSION_LEGACY;
    const deploymentId = options.deploymentId ?? run.deploymentId;

    const newRun = await start(
      { workflowId: run.workflowName },
      workflowArgs as unknown[],
      {
        deploymentId,
        world,
        specVersion,
      }
    );
    return newRun.runId;
  } catch (err) {
    throw new Error(
      `Failed to recreate run from ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Cancel a workflow run.
 */
export async function cancelRun(world: World, runId: string): Promise<void> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'none' });
    const specVersion = run.specVersion ?? SPEC_VERSION_LEGACY;
    const compatMode = isLegacySpecVersion(specVersion);
    const eventData = {
      eventType: 'run_cancelled' as const,
      specVersion,
    };
    await world.events.create(runId, eventData, { v1Compat: compatMode });
  } catch (err) {
    throw new Error(
      `Failed to cancel run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Re-enqueue a workflow run.
 */
export async function reenqueueRun(world: World, runId: string): Promise<void> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'none' });
    await world.queue(
      getWorkflowQueueName(run.workflowName),
      {
        runId,
      },
      {
        deploymentId: run.deploymentId,
      }
    );
  } catch (err) {
    throw new Error(
      `Failed to re-enqueue run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Wake up a workflow run by interrupting pending sleep() calls.
 */
export async function wakeUpRun(
  world: World,
  runId: string,
  options?: StopSleepOptions
): Promise<StopSleepResult> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'none' });
    const compatMode = isLegacySpecVersion(run.specVersion);

    // Paginate through all events to ensure we don't miss any sleeps
    // in long-running workflows with more than 1000 events.
    const allEvents: Event[] = [];
    let cursor: string | null = null;
    do {
      const eventsResult = await world.events.list({
        runId,
        pagination: { limit: 1000, ...(cursor ? { cursor } : {}) },
        resolveData: 'none',
      });
      allEvents.push(...eventsResult.data);
      cursor = eventsResult.hasMore ? eventsResult.cursor : null;
    } while (cursor);

    const waitCreatedEvents = allEvents.filter(
      (event: Event) => event.eventType === 'wait_created'
    );
    const waitCompletedCorrelationIds = new Set(
      allEvents
        .filter((event: Event) => event.eventType === 'wait_completed')
        .map((event: Event) => event.correlationId)
    );

    let pendingWaits = waitCreatedEvents.filter(
      (event: Event) => !waitCompletedCorrelationIds.has(event.correlationId)
    );

    if (options?.correlationIds && options.correlationIds.length > 0) {
      const targetCorrelationIds = new Set(options.correlationIds);
      pendingWaits = pendingWaits.filter(
        (event: Event) =>
          event.correlationId && targetCorrelationIds.has(event.correlationId)
      );
    }

    const errors: Error[] = [];
    let stoppedCount = 0;

    for (const waitEvent of pendingWaits) {
      if (!waitEvent.correlationId) continue;
      const eventData = compatMode
        ? {
            eventType: 'wait_completed' as const,
            correlationId: waitEvent.correlationId,
          }
        : {
            eventType: 'wait_completed' as const,
            correlationId: waitEvent.correlationId,
            specVersion: run.specVersion,
          };
      try {
        await world.events.create(runId, eventData, { v1Compat: compatMode });
        stoppedCount++;
      } catch (err) {
        if (WorkflowAPIError.is(err) && err.status === 409) {
          stoppedCount++;
        } else {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    if (stoppedCount > 0) {
      await world.queue(
        getWorkflowQueueName(run.workflowName),
        {
          runId,
        },
        {
          deploymentId: run.deploymentId,
        }
      );
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to complete ${errors.length}/${pendingWaits.length} pending wait(s) for run ${runId}`
      );
    }

    return { stoppedCount };
  } catch (err) {
    if (err instanceof AggregateError) {
      throw err;
    }
    throw new Error(
      `Failed to wake up run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Read from a stream by stream ID.
 * Returns a ReadableStream of Uint8Array chunks.
 */
export async function readStream(
  world: World,
  streamId: string,
  options?: ReadStreamOptions
): Promise<ReadableStream<Uint8Array>> {
  try {
    return await world.readFromStream(streamId, options?.startIndex);
  } catch (err) {
    throw new Error(
      `Failed to read stream ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * List all stream IDs for a workflow run.
 */
export async function listStreams(
  world: World,
  runId: string
): Promise<string[]> {
  try {
    return await world.listStreamsByRunId(runId);
  } catch (err) {
    throw new Error(
      `Failed to list streams for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}
