import { EntityConflictError } from '@workflow/errors';
import {
  type Event,
  isLegacySpecVersion,
  SPEC_VERSION_LEGACY,
  type World,
} from '@workflow/world';
import { importKey } from '../encryption.js';
import { hydrateWorkflowArguments } from '../serialization.js';
import { getWorkflowQueueName } from './helpers.js';
import { start } from './start.js';

export interface RecreateRunOptions {
  deploymentId?: string;
  specVersion?: number;
  /**
   * Queue namespace of the target deployment (e.g. `'eve'` for topics like
   * `__eve_wkf_workflow_*`). Falls back to `WORKFLOW_QUEUE_NAMESPACE` in
   * the calling process. Cross-context callers (e.g. the observability
   * dashboard) must pass the target deployment's namespace explicitly —
   * a run enqueued to a topic the target deployment has no consumer for
   * is never picked up.
   */
  namespace?: string;
}

export interface StopSleepResult {
  /** Number of pending sleeps that were stopped */
  stoppedCount: number;
}

export interface ReadStreamOptions {
  /**
   * The index to start reading from. Defaults to 0.
   * Negative values start from the end (e.g. -3 reads the last 3 chunks).
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
  /**
   * Queue namespace of the run's deployment (e.g. `'eve'`), used when
   * re-enqueueing the run after completing its waits. Falls back to
   * `WORKFLOW_QUEUE_NAMESPACE` in the calling process. Cross-context
   * callers (e.g. the observability dashboard) must pass it explicitly.
   */
  namespace?: string;
}

export interface ReenqueueRunOptions {
  /**
   * Queue namespace of the run's deployment (e.g. `'eve'`). Falls back to
   * `WORKFLOW_QUEUE_NAMESPACE` in the calling process. Cross-context
   * callers (e.g. the observability dashboard) must pass it explicitly.
   */
  namespace?: string;
}

export interface CancelRunOptions {
  /**
   * Optional free-text reason for the cancellation (max 512 chars), recorded
   * on the run_cancelled event and surfaced in the run detail view.
   */
  cancelReason?: string;
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
    const rawKey = await world.getEncryptionKeyForRun?.(run);
    const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
    const workflowArgs = normalizeWorkflowArgs(
      await hydrateWorkflowArguments(
        run.input,
        runId,
        encryptionKey,
        globalThis
      )
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
        namespace: options.namespace,
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
 *
 * @param options - Optional cancellation settings. `cancelReason` records a
 *   free-text reason (max 512 chars) on the run_cancelled event.
 */
export async function cancelRun(
  world: World,
  runId: string,
  options?: CancelRunOptions
): Promise<void> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'none' });
    const specVersion = run.specVersion ?? SPEC_VERSION_LEGACY;
    const compatMode = isLegacySpecVersion(specVersion);
    const eventRequest = {
      eventType: 'run_cancelled' as const,
      specVersion,
      ...(options?.cancelReason !== undefined
        ? { eventData: { cancelReason: options.cancelReason } }
        : {}),
    };
    await world.events.create(runId, eventRequest, { v1Compat: compatMode });
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
export async function reenqueueRun(
  world: World,
  runId: string,
  options?: ReenqueueRunOptions
): Promise<void> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'none' });
    await world.queue(
      getWorkflowQueueName(run.workflowName, options?.namespace),
      {
        runId,
      },
      {
        deploymentId: run.deploymentId,
        specVersion: run.specVersion ?? SPEC_VERSION_LEGACY,
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
            eventData: {
              resumeAt: waitEvent.eventData.resumeAt,
            },
          };
      try {
        await world.events.create(runId, eventData, { v1Compat: compatMode });
        stoppedCount++;
      } catch (err) {
        if (EntityConflictError.is(err)) {
          stoppedCount++;
        } else {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    if (stoppedCount > 0) {
      await world.queue(
        getWorkflowQueueName(run.workflowName, options?.namespace),
        {
          runId,
        },
        {
          deploymentId: run.deploymentId,
          specVersion: run.specVersion ?? SPEC_VERSION_LEGACY,
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
  runId: string,
  streamId: string,
  options?: ReadStreamOptions
): Promise<ReadableStream<Uint8Array>> {
  try {
    return await world.streams.get(runId, streamId, options?.startIndex);
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
    return await world.streams.list(runId);
  } catch (err) {
    throw new Error(
      `Failed to list streams for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}
