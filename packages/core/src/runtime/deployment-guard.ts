import {
  EntityConflictError,
  RUN_ERROR_CODES,
  RunExpiredError,
  WorkflowDeploymentMismatchError,
} from '@workflow/errors';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { dehydrateRunError } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getDeploymentMismatchMaxRetries } from './constants.js';

/** Cap on the re-route backoff, in seconds. */
const MAX_REROUTE_DELAY_SECONDS = 8;

/**
 * How the guard resolved a delivery. Both non-`continue` outcomes mean the
 * caller must ack the message and return without executing anything.
 */
export type DeploymentAffinityOutcome =
  /** The run belongs here (or this world has no deployment affinity). */
  | 'continue'
  /** Misrouted; re-enqueued at the run's own deployment. */
  | 'rerouted'
  /** Misrouted and out of budget (or unroutable); `run_failed` recorded. */
  | 'failed';

/**
 * `spanAttributes` is present only on a misrouted delivery — mismatches are
 * rare, so the presence of `workflow.deployment.pinned_id` on a span *is* the
 * signal that one happened, and `recovered` separates the ones a re-route fixed
 * from the ones that kept misrouting.
 */
export interface DeploymentAffinityResult {
  outcome: DeploymentAffinityOutcome;
  spanAttributes?: Record<string, string | number | boolean>;
}

/** The common case, allocation-free. */
const CONTINUE: DeploymentAffinityResult = { outcome: 'continue' };

/**
 * Builds a stopping result. `attempts` is the re-route count *including* this
 * invocation's own attempt, so the span attribute reads as "attempts so far".
 */
function result(
  outcome: 'rerouted' | 'failed',
  pinnedDeploymentId: string,
  attempts: number
): DeploymentAffinityResult {
  return {
    outcome,
    spanAttributes: {
      ...Attribute.WorkflowRunPinnedDeploymentId(pinnedDeploymentId),
      ...Attribute.WorkflowDeploymentMismatchRetryCount(attempts),
      ...Attribute.WorkflowDeploymentMismatchRecovered(outcome === 'rerouted'),
    },
  };
}

/**
 * Arguments handed to a call site's re-enqueue closure. The guard owns the
 * policy — counting, backoff, logging, telemetry, escalation — and the call
 * site owns only the shape of the message it needs to put back on the queue.
 */
export interface ReenqueueArgs {
  /** The deployment to target: the one the run is pinned to. */
  deploymentId: string;
  /**
   * The run's spec version, so the world picks the right queue transport
   * (CBOR vs JSON). Undefined on legacy runs that predate the field; worlds
   * then fall back to their current default.
   */
  specVersion: number | undefined;
  deploymentMismatchRetryCount: number;
  /** Backoff before the re-routed message becomes visible. */
  delaySeconds: number;
}

/**
 * Guards deployment affinity: a run may only execute on the deployment it is
 * pinned to.
 *
 * A run's `deploymentId` is fixed when it starts — the deployment that called
 * `start()`, or whatever `start({ deploymentId })` resolved to (an explicit id
 * or `'latest'`) — and no replay or step execution may happen anywhere else:
 * the bundles here may not match the run's persisted history, and any step
 * dispatched from here derives the per-run encryption key from the wrong
 * deployment's master key, which surfaces as a `RuntimeDecryptionError` the
 * queue retry callback swallows into a blank "exceeded max retries".
 *
 * A misrouted delivery is not treated as permanent. Rather than failing
 * immediately, re-enqueue the message *explicitly targeted* at the run's own
 * deployment; that send is strictly better-addressed than the one that
 * misrouted, which inherited the producing deployment's ambient id. Fail only
 * once the budget (`WORKFLOW_DEPLOYMENT_MISMATCH_MAX_RETRIES`, default 3) is
 * spent, mirroring how a replay divergence gets bounded recovery replays before
 * being recorded as a corrupted event log.
 *
 * Callers must pass a run entity they already have in hand — every call site
 * loads the run for other reasons — so the guard costs no extra round trip.
 * (`world.getDeploymentId()` reads the ambient deployment id, e.g.
 * `VERCEL_DEPLOYMENT_ID`, and does not call the backend either.)
 *
 * The failure is recorded **without resolving the run's encryption key**: the
 * key is fetched from the pinned deployment's API, often unavailable once that
 * deployment is past its retention window, so depending on it would throw here
 * instead of recording the failure. The payload is written unencrypted (it
 * holds only deployment ids, nothing sensitive), and the plaintext `errorCode`
 * is the signal observability and the UI key off.
 */
export async function guardDeploymentAffinity({
  world,
  run,
  requestId,
  retryCount = 0,
  reenqueue,
  isDeploymentUnavailableError,
  beforeStop,
}: {
  world: World;
  run: Pick<WorkflowRun, 'runId' | 'deploymentId' | 'specVersion'>;
  requestId?: string;
  /** `deploymentMismatchRetryCount` from the incoming message, if any. */
  retryCount?: number;
  /**
   * Puts this delivery's message back on the queue, targeted at the run's own
   * deployment. Omitted by callers that cannot reconstruct their message, which
   * makes the guard fail-fast.
   */
  reenqueue?: (args: ReenqueueArgs) => Promise<void>;
  /**
   * Classifies a re-enqueue failure as definitive proof that the pinned
   * deployment cannot receive the message. Unclassified failures are retried
   * by rejecting the handler and leaving the current queue message unacked.
   */
  isDeploymentUnavailableError?: (error: unknown) => boolean;
  /**
   * Ordering barrier awaited once a mismatch is confirmed, before either
   * stopping action. Under turbo the `run_started` write is backgrounded, and
   * both outcomes hand the run off (to a `run_failed` here, or to the pinned
   * deployment's own `run_started`) — so that write must have landed first.
   */
  beforeStop?: () => Promise<void>;
}): Promise<DeploymentAffinityResult> {
  // Deployment affinity is only meaningful in worlds whose deployments are
  // atomic and immutable, which the World declares (world-vercel does) and
  // capabilities default to unsupported. Local and self-hosted worlds report a
  // synthetic deployment id (e.g. `dpl_local@<sdk-version>`) that legitimately
  // differs across SDK versions within one logical environment, so guarding
  // them would fail ordinary local runs after a version bump.
  if (world.capabilities?.deploymentAffinity !== true) {
    return CONTINUE;
  }

  const currentDeploymentId = await world.getDeploymentId();
  if (run.deploymentId === currentDeploymentId) {
    return CONTINUE;
  }

  await beforeStop?.();

  const maxRetries = getDeploymentMismatchMaxRetries();
  const logContext = {
    workflowRunId: run.runId,
    pinnedDeploymentId: run.deploymentId,
    actualDeploymentId: currentDeploymentId,
    retryCount,
    maxRetries,
  };

  /**
   * Records the terminal `run_failed`. Mirrors `recordFatalRunError`: it
   * records and returns rather than throwing, so the caller acks the message
   * instead of letting the queue redeliver a run that is now terminal.
   */
  const failRun = async (
    recoveryAttempts: number,
    cause?: unknown
  ): Promise<DeploymentAffinityResult> => {
    const error = new WorkflowDeploymentMismatchError(
      run.runId,
      run.deploymentId,
      currentDeploymentId,
      { recoveryAttempts, cause }
    );

    try {
      await world.events.create(
        run.runId,
        {
          eventType: 'run_failed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            // Unencrypted (undefined key): see the note on
            // `guardDeploymentAffinity`. dehydrate/hydrate are self-describing,
            // so this reads back without a key.
            error: await dehydrateRunError(
              error,
              run.runId,
              undefined,
              undefined,
              (run.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION
            ),
            errorCode: RUN_ERROR_CODES.DEPLOYMENT_MISMATCH,
          },
        },
        { requestId }
      );
    } catch (failError) {
      // Run already reached a terminal state (a concurrent writer failed it, or
      // it was cancelled/expired) — still stop. Anything else is a transient
      // persistence failure: rethrow so the queue redelivers and we try again.
      if (
        !EntityConflictError.is(failError) &&
        !RunExpiredError.is(failError)
      ) {
        throw failError;
      }
    }
    return result('failed', run.deploymentId, recoveryAttempts);
  };

  if (reenqueue && retryCount < maxRetries) {
    const attempt = retryCount + 1;
    // Exponential, capped: 1s, 2s, 4s — cheap insurance against a hot
    // re-enqueue loop, and time for a mid-flight routing change to settle.
    const delaySeconds = Math.min(2 ** retryCount, MAX_REROUTE_DELAY_SECONDS);
    try {
      await reenqueue({
        deploymentId: run.deploymentId,
        specVersion: run.specVersion,
        deploymentMismatchRetryCount: attempt,
        delaySeconds,
      });
      runtimeLogger.warn(
        'Workflow run received by a deployment it is not pinned to; re-routing to its own deployment',
        { ...logContext, attempt, delaySeconds }
      );
      return result('rerouted', run.deploymentId, attempt);
    } catch (reenqueueError) {
      // A generic send failure can be transient (429, 5xx, connect/DNS). Do not
      // turn one infrastructure blip into a terminal run failure: reject the
      // handler so the current message remains unacked and is redelivered.
      if (!isDeploymentUnavailableError?.(reenqueueError)) {
        throw reenqueueError;
      }

      // The World explicitly classified the target as unavailable — deleted,
      // aged out of its retention window, or otherwise undiscoverable. Burning
      // the rest of the budget on a deployment that provably cannot be reached
      // only delays the failure, so fail now.
      runtimeLogger.error(
        'Cannot re-route a misrouted workflow run to its own deployment; failing the run',
        {
          ...logContext,
          attempt,
          errorMessage:
            reenqueueError instanceof Error
              ? reenqueueError.message
              : String(reenqueueError),
        }
      );
      // Recovery never actually happened, so report 0 attempts and let `cause`
      // explain why.
      return failRun(0, reenqueueError);
    }
  }

  runtimeLogger.error(
    retryCount > 0
      ? 'Workflow run kept arriving at a deployment it is not pinned to after re-routing; failing the run'
      : 'Workflow run received by a deployment it is not pinned to; failing the run',
    logContext
  );
  return failRun(retryCount);
}
