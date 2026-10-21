/**
 * Lock handoff wakes (`WorldCapabilities.locks.fifo`).
 *
 * A FIFO World never wakes a run itself. Every write that reserved a slot for
 * a waiter (a release, a terminal run event whose reclaim freed one, an
 * acquisition that moved a stale grant on) returns the grantees on
 * `EventResult.lockHandoffs`, and the runtime that made the write sends each
 * one a wake to the target the grantee stored when it queued. The grantee's
 * run replays, re-POSTs its `lock_created`, and claims the slot.
 *
 * The wake is best effort and never a gate: a failed publish is logged and
 * dropped, and the releasing run completes regardless. A lost wake is
 * recovered by grant grace (the next write on the key moves the stale
 * reservation on to someone else) or by the grantee's own backstop retry.
 */
import type {
  LockHandoff,
  LockWakeTarget,
  ValidQueueName,
  WorkflowInvokePayload,
  World,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { getWorkflowQueueName, queueMessage } from './helpers.js';

/**
 * Where this run's own wake should go, for the `lock_created` it sends a FIFO
 * World. `undefined` on a World without `locks.fifo`, which then gets no wake
 * target and keeps polling.
 */
export function lockWakeTargetFor(
  world: World,
  run: { workflowName: string; deploymentId?: string; specVersion?: number },
  namespace?: string
): LockWakeTarget | undefined {
  if (world.capabilities?.locks?.fifo !== true) return undefined;
  return {
    queueName: getWorkflowQueueName(run.workflowName, namespace),
    ...(run.deploymentId && { deploymentId: run.deploymentId }),
    ...(run.specVersion !== undefined && { specVersion: run.specVersion }),
  };
}

/**
 * The wake's idempotency key. Per grant, not per scope: a scope that grace
 * moved back can be granted again, and its second wake must not collapse onto
 * the first.
 */
export function lockWakeIdempotencyKey(handoff: LockHandoff): string {
  return `lock-wake:${handoff.runId}:${handoff.correlationId}:${new Date(
    handoff.grantedAt
  ).getTime()}`;
}

/** Send each grantee its wake. Never throws. */
export async function wakeLockGrantees(
  world: World,
  handoffs: readonly LockHandoff[] | undefined,
  context: { runId: string }
): Promise<void> {
  if (!handoffs || handoffs.length === 0) return;
  await Promise.all(
    handoffs.map(async (handoff) => {
      if (!handoff.wake) {
        // Nowhere to send it: the grantee claims at its backstop.
        runtimeLogger.info('Lock handoff without a wake target', {
          workflowRunId: context.runId,
          granteeRunId: handoff.runId,
          correlationId: handoff.correlationId,
        });
        return;
      }
      try {
        await queueMessage(
          world,
          handoff.wake.queueName as ValidQueueName,
          {
            runId: handoff.runId,
            requestedAt: new Date(),
          } satisfies WorkflowInvokePayload,
          {
            idempotencyKey: lockWakeIdempotencyKey(handoff),
            ...(handoff.wake.deploymentId && {
              deploymentId: handoff.wake.deploymentId,
            }),
            ...(handoff.wake.specVersion !== undefined && {
              specVersion: handoff.wake.specVersion,
            }),
          }
        );
      } catch (err) {
        runtimeLogger.warn(
          'Lock handoff wake failed; the grantee claims at grace or backstop',
          {
            workflowRunId: context.runId,
            granteeRunId: handoff.runId,
            correlationId: handoff.correlationId,
            message: err instanceof Error ? err.message : String(err),
          }
        );
      }
    })
  );
}
