import { FatalError, RUN_ERROR_CODES } from '@workflow/errors';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { dehydrateRunError } from '../serialization.js';
import { memoizeEncryptionKey } from './helpers.js';
import { getWorld } from './world.js';

/**
 * Fail a run whose event log has exceeded the max event count. Deterministic
 * (a redelivery would replay the same over-limit log), so unlike
 * `handleReplayBudgetExhausted` there's no retry/`process.exit` — just write a
 * best-effort terminal `run_failed` with MAX_EVENTS_EXCEEDED and return.
 */
export async function handleEventLimitExceeded(args: {
  runId: string;
  workflowName: string;
  requestId: string | undefined;
  eventCount: number;
  limit: number;
}): Promise<void> {
  const { runId, workflowName, requestId, eventCount, limit } = args;
  const runLogger = runtimeLogger.forRun(runId, workflowName);

  runLogger.error(
    'Workflow exceeded the maximum number of events; failing the run',
    { eventCount, limit }
  );

  try {
    const world = await getWorld();
    const getEncryptionKey = memoizeEncryptionKey(world, runId);
    const limitErr = new FatalError(
      `Workflow exceeded the maximum of ${limit} events per run`
    );
    await world.events.create(
      runId,
      {
        eventType: 'run_failed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          error: await dehydrateRunError(
            limitErr,
            runId,
            await getEncryptionKey()
          ),
          errorCode: RUN_ERROR_CODES.MAX_EVENTS_EXCEEDED,
        },
      },
      { requestId }
    );
  } catch (err) {
    // Best-effort: the run stops anyway when the loop returns; log why.
    runLogger.warn('Unable to mark run as failed after exceeding event limit', {
      errorName: err instanceof Error ? err.name : 'UnknownError',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
