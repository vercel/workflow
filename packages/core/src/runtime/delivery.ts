/**
 * One orchestrator delivery, as both orchestrators see it: what the shared
 * entrypoint (`../runtime.ts`) hands to the orchestrator for the run's spec
 * version, and the helpers both use.
 *
 * - Spec 8 and below (`./spec8/`): several orchestrator invocations of a run
 *   may write at once; steps keep entities and the World's precondition guard
 *   keeps their writes consistent.
 * - Spec 9 (`./spec9/`): one writer per run, enforced by the World's in-band
 *   fence; steps are folded from the log.
 *
 * A run keeps the orchestrator of the spec version it was created with.
 */

import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  RUN_ERROR_CODES,
  type RunErrorCode,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import type { Queue } from '@workflow/world';
import {
  type CreateEventRequest,
  type Event,
  type resolveQueueNamespace,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowInvokePayload,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import ms from 'ms';
import { isWorldContractError } from '../classify-error.js';
import type { WorkflowSuspension } from '../global.js';
import { type Logger, runtimeLogger } from '../logger.js';
import type { GuestCodeExecution } from '../serialization/hardened.js';
import {
  dehydrateRunError,
  hydrateDynamicWorkflowCode,
  type PayloadKey,
} from '../serialization.js';
import {
  DYNAMIC_WORKFLOWS_ENV,
  getMaxEventsOverride,
  isDynamicWorkflowsEnabled,
  isVmRetentionEnabled,
} from './constants.js';
import {
  type DynamicWorkflowMetadata,
  dynamicWorkflowName,
  readDynamicWorkflowMetadata,
} from './dynamic-workflow.js';
import { memoizeEncryptionKey } from './helpers.js';
import type { RunInputActivity } from './invocations.js';
import { dispatchRunFailedHooks } from './lifecycle-hooks.js';
import type { ReplayBudget } from './replay-budget.js';
import type { ResumeTtrTracking } from './resume-latency.js';
import { specVersionForRunWrite } from './run-spec-version.js';

type QueueHandler = Parameters<Queue['createQueueHandler']>[1];

/** The queue metadata of one delivery. */
export type DeliveryMetadata = Parameters<QueueHandler>[1];

/**
 * What a delivery hands back to the queue: a redelivery delay, a handoff to
 * the next delivery (spec 9, see `Queue.createQueueHandler`), or nothing to
 * ack.
 */
export type DeliveryResult =
  | { timeoutSeconds: number; handoff?: true }
  | undefined;

/** One orchestrator delivery, set up by the shared entrypoint. */
export interface WorkflowDelivery {
  /** The parsed queue message. */
  readonly message: WorkflowInvokePayload;
  readonly metadata: DeliveryMetadata;
  /**
   * The run's input activity for this handler, on Worlds that deliver
   * invocations (`capabilities.invoke`); see `withRunInputs`.
   */
  readonly activity: RunInputActivity | undefined;
  readonly workflowCode: string;
  readonly namespace: ReturnType<typeof resolveQueueNamespace>;
  readonly world: World;
  /** The delivery's `workflow.execute` span. */
  readonly span: Span | undefined;
  readonly runLogger: Logger;
  readonly workflowName: string;
  readonly requestId: string | undefined;
  /** Hook-resume TTR tracking, consumed by the first durable step after it. */
  readonly resumeTracking: ResumeTtrTracking | undefined;
  /** Trace carrier to attach to the messages this delivery enqueues. */
  readonly nextTraceCarrier: () => Promise<Record<string, string>>;
  readonly replayBudget: ReplayBudget;
  /**
   * The run (`resolveData: 'none'`), when routing the delivery had to read
   * it; a read that wants the same view uses it instead of reading again.
   */
  readonly prefetchedRun: WorkflowRun | undefined;
}

/** What the shared entrypoint needs from the orchestrator of a run's spec. */
export interface Orchestrator {
  /** Whether a delivery of `message` counts toward the run's max queue deliveries. */
  countsTowardMaxDeliveries(message: WorkflowInvokePayload): boolean;
  /**
   * Writes the `run_failed` that ends a run past its max queue deliveries.
   * Resolves `'superseded'` when another orchestrator invocation is writing
   * the run, which is then not stuck and is left to it. Otherwise throws what
   * the World threw.
   */
  writeMaxDeliveriesFailure(
    world: World,
    runId: string,
    eventData: RunFailedEventRequest['eventData'],
    requestId: string | undefined
  ): Promise<'written' | 'superseded'>;
  /** Runs one delivery of the run's queue message. */
  runDelivery(delivery: WorkflowDelivery): Promise<DeliveryResult>;
}

/**
 * A workflow-code execution observed while a suspension serialized its
 * writes, which keeps the retained VM from being reused (see
 * `getRetentionDecision`).
 */
export interface SuspensionSerializationBlocker extends GuestCodeExecution {
  source: 'step_input' | 'hook_metadata' | 'hook_abort';
  correlationId: string;
}

/** The max-deliveries `run_failed` request. */
export type RunFailedEventRequest = Extract<
  CreateEventRequest,
  { eventType: 'run_failed' }
>;

/** The workflow code a delivery replays, and the marker when it is dynamic. */
export interface ResolvedWorkflowCode {
  code: string;
  dynamicWorkflow?: DynamicWorkflowMetadata;
}

export type RetentionDecision =
  | { retain: true }
  | {
      retain: false;
      reason:
        | 'disabled'
        | 'serialization_executed_workflow_code'
        | 'no_replay_driver';
    };

/**
 * The complete retained-VM policy for a suspension boundary.
 *
 * Every suspension producer uses the suspension-generation guard when
 * signaling. Otherwise a signal scheduled at boundary N could suspend the VM
 * after it has already resumed into boundary N+1. The strictly ordered event
 * log determines which branch resolution wins. A step or attribute write is
 * required to drive the next inline iteration; hook- or wait-only suspensions
 * park normally.
 *
 * Retaining across an open hook or wait also permits an out-of-band cold replay
 * to race this invocation. That is safe only because each loaded log is a
 * monotone, hole-free prefix; replaying a longer prefix preserves all earlier
 * correlation-ID draws; and `step_started` atomically chooses one owner. The
 * generation guard keeps losing same-boundary suspension signals stale, while
 * a stale-snapshot/412 restart discards the retained session and replays from
 * the authoritative log. A World that exposes a non-prefix view would violate
 * this policy's precondition and could bind one ordinal to two logical branches
 * before the step-ownership claim has a chance to arbitrate them.
 *
 * A hook-write continuation is the one boundary retained without a step or
 * attribute driver. The suspension committed the event a hook's own awaiter is
 * parked on — the `hook_created` a `hook.getConflict()` waits for, or the
 * `hook_conflict` a create whose token was already claimed committed instead —
 * and the caller advances the workflow over that event by resuming the session
 * in this process rather than re-invoking (see `continueOverHookWrite` in the
 * replay loop), so the runtime itself drives the next iteration. One arm for
 * both outcomes because it is one boundary: same write, same event slot, same
 * continuation. Steps in the same suspension ride along queued: an awaiter
 * empties `lazyInlineSteps` and the conflict branch returns before any inline
 * execution, so nothing this invocation does can order the continuation behind
 * a step body. The hook this suspension just created is an open hook by
 * definition, and is no more a hazard than any other open hook here: a
 * `hook_received` landing out of band is absent from the log the resume reads
 * exactly as it is absent from a fetch that returned a moment before it — a
 * prefix, never a hole, corrected on the next write.
 *
 * Quiescence assumes workflow code stays inside the sandbox's determinism
 * contract. Escaping to the host realm (for example, recovering a host
 * `Function` constructor to schedule real timers) already makes ordinary cold
 * replay nondeterministic and is not defended here.
 *
 */
export function getRetentionDecision({
  suspension,
  serializationBlockerCount,
  hookContinuation = false,
  invocationContinuation = false,
}: {
  suspension: WorkflowSuspension;
  serializationBlockerCount: number;
  /**
   * Whether this suspension committed the event a hook's own awaiter is
   * waiting on and the caller will continue over it in-process, making the
   * runtime the replay driver for a boundary that has no step or attribute
   * write of its own. See the policy above.
   */
  hookContinuation?: boolean;
  invocationContinuation?: boolean;
}): RetentionDecision {
  if (!isVmRetentionEnabled()) {
    return { retain: false, reason: 'disabled' };
  }
  if (serializationBlockerCount > 0) {
    return {
      retain: false,
      reason: 'serialization_executed_workflow_code',
    };
  }
  if (hookContinuation) {
    return { retain: true };
  }
  if (
    !invocationContinuation &&
    suspension.stepCount === 0 &&
    suspension.attributeCount === 0
  ) {
    return { retain: false, reason: 'no_replay_driver' };
  }
  return { retain: true };
}

export const SERIALIZATION_BLOCKER_LOG_DETAIL_LIMIT = 160;

/** Keep retention diagnostics useful without emitting unbounded guest data. */
export function serializationBlockerLogMetadata(
  blockers: SuspensionSerializationBlocker[],
  count: number
) {
  return {
    serializationBlockerCount: count,
    serializationBlockers: blockers.map(
      ({ source, correlationId, kind, detail }) => ({
        source,
        correlationId,
        kind,
        detail:
          detail && detail.length > SERIALIZATION_BLOCKER_LOG_DETAIL_LIMIT
            ? `${detail.slice(0, SERIALIZATION_BLOCKER_LOG_DETAIL_LIMIT)}…`
            : detail,
      })
    ),
    serializationBlockersTruncated: count > blockers.length,
  };
}

export function clampMaxEvents(
  serverValue: number | undefined
): number | undefined {
  const override = getMaxEventsOverride();
  if (override === undefined) return serverValue;
  return serverValue === undefined ? override : Math.min(serverValue, override);
}

export function findRecordedTerminalRunEvent(
  events: Event[],
  runId: string
): Event | undefined {
  // Terminal run events are always last by construction (no event creation
  // succeeds against a terminal run), but scan the full array for
  // defense-in-depth: a World/backend ordering bug shouldn't make us miss an
  // actual termination signal.
  return events.find(
    (e) =>
      e.runId === runId &&
      (e.eventType === 'run_completed' ||
        e.eventType === 'run_failed' ||
        e.eventType === 'run_cancelled')
  );
}

export function hasRecordedTerminalRunEvent(
  events: Event[],
  runId: string
): boolean {
  const terminalRunEvent = findRecordedTerminalRunEvent(events, runId);

  if (!terminalRunEvent) {
    return false;
  }

  runtimeLogger.debug('Run reached terminal event, exiting', {
    workflowRunId: runId,
    eventType: terminalRunEvent.eventType,
    eventId: terminalRunEvent.eventId,
  });
  return true;
}

/**
 * Maximum inline-execution duration for a single handler invocation.
 *
 * Order of precedence:
 * 1. `WORKFLOW_V2_TIMEOUT_MS` env var
 * 2. Tiered budget derived from `world.getRuntimeDeadline()`
 * 3. Default of 2 minutes
 */
export async function getMaxInlineDurationMs(
  world: World,
  invocationStartTime: number
): Promise<number> {
  const rawEnvOverride = process.env.WORKFLOW_V2_TIMEOUT_MS;
  if (rawEnvOverride !== undefined && rawEnvOverride !== '') {
    const parsed = Number(rawEnvOverride);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const runtimeDeadline = await world.getRuntimeDeadline?.();
  if (runtimeDeadline !== undefined) {
    const deadlineMs = runtimeDeadline.getTime();
    if (!Number.isNaN(deadlineMs)) {
      const maxDurationMs = Math.floor(deadlineMs - invocationStartTime);
      if (maxDurationMs >= ms('25m')) {
        return ms('10m');
      }

      if (maxDurationMs >= ms('10m')) {
        return ms('5m');
      }
    }
  }

  return ms('2m');
}

export function getWorkflowSetupErrorCode(err: unknown): RunErrorCode | null {
  if (WorkflowRuntimeError.is(err)) {
    return RUN_ERROR_CODES.RUNTIME_ERROR;
  }

  if (isWorldContractError(err)) {
    return RUN_ERROR_CODES.WORLD_CONTRACT_ERROR;
  }

  return null;
}

export async function recordFatalRunError({
  world,
  workflowRun,
  runId,
  workflowName,
  requestId,
  err,
  errorCode,
  logMessage,
}: {
  world: World;
  workflowRun: WorkflowRun | undefined;
  runId: string;
  workflowName: string;
  requestId: string | undefined;
  err: unknown;
  errorCode: RunErrorCode;
  logMessage: string;
}) {
  runtimeLogger.error(logMessage, {
    workflowRunId: runId,
    errorCode,
    error: err instanceof Error ? err.message : String(err),
  });

  let encryptionKey: PayloadKey | undefined;
  let dehydratedError: Uint8Array;
  try {
    const getEncryptionKey = memoizeEncryptionKey(world, workflowRun ?? runId);
    encryptionKey = await getEncryptionKey();
    dehydratedError = await dehydrateRunError(
      err,
      runId,
      encryptionKey,
      globalThis,
      (workflowRun?.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION
    );
    await world.events.create(
      runId,
      {
        eventType: 'run_failed',
        specVersion: specVersionForRunWrite(workflowRun?.specVersion),
        eventData: {
          error: dehydratedError,
          errorCode,
        },
      },
      // Written by the step invocation or before the delivery loaded the
      // log, so it carries no fence count.
      { requestId, inBand: false }
    );
  } catch (failErr) {
    if (EntityConflictError.is(failErr) || RunExpiredError.is(failErr)) {
      return;
    }
    if (isWorldContractError(failErr)) {
      runtimeLogger.error(
        'Fatal world contract error while recording workflow failure',
        {
          workflowRunId: runId,
          errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
          error: failErr instanceof Error ? failErr.message : String(failErr),
        }
      );
      return;
    }
    throw failErr;
  }
  dispatchRunFailedHooks(
    runId,
    workflowName,
    dehydratedError,
    encryptionKey,
    errorCode
  );
}

/**
 * Pick the workflow code this run replays.
 *
 * For a static run this is the deployment's bundle, returned unchanged after
 * one plaintext property read. The dynamic branch exists for runs started from
 * source: their workflow function was never in the bundle, so the code came
 * with the run, and replaying it means evaluating that exact code rather than
 * whatever the deployment now contains.
 *
 * Stored code is only executed when all of these hold, and each failure is a
 * `WorkflowRuntimeError` so the caller fails the run instead of redelivering a
 * message whose verdict cannot change:
 *
 * - this deployment has opted in to dynamic workflows;
 * - the run's `workflowName` is the id its `dynamicWorkflow` marker derives
 *   (a marker on a static workflow's run does not redirect it to stored code);
 * - the code exists and hydrates, which requires the `encr` envelope whenever
 *   the run has key material or was started with encryption.
 *
 * Two sources for the code, in order of what the invocation already holds:
 *
 * 1. On the run snapshot. The normal case: `run_created` and the queue
 *    message both carry the bytes, so a read is already unnecessary by the
 *    time replay begins.
 * 2. Read back from the run. Needed when the definition was too large to
 *    send inline and lives behind a ref, or the snapshot was read with
 *    `resolveData: 'none'`, which omits the code. The run has to exist first,
 *    hence the barrier.
 *
 * World and key-lookup errors propagate unchanged, so transient failures are
 * still redelivered.
 *
 * @param getEncryptionKey - Resolved only on the dynamic branch. The key is
 *   lazy for a reason: some deliveries never need it, and forcing it here
 *   would put a key fetch on every static run's critical path.
 * @param awaitRunReady - Orders the fallback read after the write that
 *   creates the run; a no-op once the run is durable.
 */
export async function resolveWorkflowCodeForRun(
  staticWorkflowCode: string,
  workflowRun: WorkflowRun,
  getEncryptionKey: () => Promise<PayloadKey | undefined>,
  world: World,
  awaitRunReady: () => Promise<void>
): Promise<ResolvedWorkflowCode> {
  const dynamicWorkflow = readDynamicWorkflowMetadata(
    workflowRun.executionContext
  );
  if (!dynamicWorkflow) return { code: staticWorkflowCode };

  const runLabel = `Workflow run "${workflowRun.runId}" is a dynamic workflow run (source ${dynamicWorkflow.sourceHash.slice(0, 12)})`;
  if (!isDynamicWorkflowsEnabled()) {
    throw new WorkflowRuntimeError(
      `${runLabel}, but this deployment has not enabled dynamic workflows, so its stored code was not executed. Set ${DYNAMIC_WORKFLOWS_ENV}=1 on the deployment to enable them.`
    );
  }
  const expectedWorkflowName = dynamicWorkflowName(dynamicWorkflow);
  if (workflowRun.workflowName !== expectedWorkflowName) {
    throw new WorkflowRuntimeError(
      `${runLabel}, but its workflow name ${JSON.stringify(workflowRun.workflowName)} does not match the dynamic id ${JSON.stringify(expectedWorkflowName)} its marker derives, so its stored code was not executed.`
    );
  }

  let stored = workflowRun.dynamicWorkflowCode;
  if (stored === undefined) {
    await awaitRunReady();
    stored = (await world.runs.get(workflowRun.runId, { resolveData: 'all' }))
      .dynamicWorkflowCode;
  }

  if (stored === undefined) {
    throw new WorkflowRuntimeError(
      `${runLabel}, but its stored workflow code is missing, so it cannot be replayed. ` +
        'This means the code was never persisted or its storage has expired.'
    );
  }

  const encryptionKey = await getEncryptionKey();
  const features = workflowRun.executionContext?.features as
    | { encryption?: unknown }
    | undefined;
  try {
    return {
      code: await hydrateDynamicWorkflowCode(stored, encryptionKey, {
        encryptionRequired: features?.encryption === true,
      }),
      dynamicWorkflow,
    };
  } catch (cause) {
    throw new WorkflowRuntimeError(
      `${runLabel}, but its stored workflow code could not be decoded, so it was not executed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}
