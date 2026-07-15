import {
  EntityConflictError,
  RUN_ERROR_CODES,
  RunExpiredError,
  WorkflowDeploymentMismatchError,
} from '@workflow/errors';
import {
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { dehydrateRunError } from '../serialization.js';

/**
 * Fails a run that reached a deployment other than its persisted owner by
 * recording a `run_failed` carrying the `DEPLOYMENT_MISMATCH` error code.
 *
 * Returns `true` when the run was stopped — the caller must ack and stop — and
 * `false` when execution is safe to continue. Mirrors `recordFatalRunError`:
 * it records and returns rather than throwing, so the caller acks the message
 * instead of letting the queue redeliver a run that is now terminal. Only an
 * unexpected persistence failure is thrown, so the queue redelivers and retries
 * the write.
 *
 * The failure is recorded **without resolving the run's encryption key**. This
 * guard fires precisely when a run outlived its origin deployment, whose key is
 * fetched from that deployment's API — often unavailable once it's past its
 * retention window. Depending on it would throw here and drop us back into the
 * silent retry-exhaustion this guard exists to replace. The error payload is
 * written unencrypted (it holds only deployment ids, nothing sensitive), and
 * the plaintext `errorCode` is the signal observability and the UI key off.
 */
export async function failRunIfDeploymentMismatch({
  world,
  run,
  requestId,
  beforeFail,
}: {
  world: World;
  run: Pick<WorkflowRun, 'runId' | 'deploymentId' | 'specVersion'>;
  requestId?: string;
  beforeFail?: () => Promise<void>;
}): Promise<boolean> {
  const currentDeploymentId = await world.getDeploymentId();
  if (run.deploymentId === currentDeploymentId) {
    return false;
  }

  const error = new WorkflowDeploymentMismatchError(
    run.runId,
    run.deploymentId,
    currentDeploymentId
  );
  runtimeLogger.error('Workflow run received by the wrong deployment', {
    workflowRunId: run.runId,
    expectedDeploymentId: run.deploymentId,
    actualDeploymentId: currentDeploymentId,
    errorMessage: error.message,
  });

  try {
    await beforeFail?.();
    await world.events.create(
      run.runId,
      {
        eventType: 'run_failed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          // Unencrypted (undefined key): see the note on this function — the
          // origin deployment's key may be gone. dehydrate/hydrate are
          // self-describing, so this reads back without a key.
          error: await dehydrateRunError(error, run.runId, undefined),
          errorCode: RUN_ERROR_CODES.DEPLOYMENT_MISMATCH,
        },
      },
      { requestId }
    );
  } catch (failError) {
    // Run already reached a terminal state (a concurrent writer failed it, or
    // it was cancelled/expired) — still stop. Anything else is a transient
    // persistence failure: rethrow so the queue redelivers and we try again.
    if (EntityConflictError.is(failError) || RunExpiredError.is(failError)) {
      return true;
    }
    throw failError;
  }

  return true;
}
