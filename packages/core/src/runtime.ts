import assert from 'node:assert/strict';
import { types } from 'node:util';
import {
  CorruptedEventLogError,
  EntityConflictError,
  FatalError,
  HookNotFoundError,
  MaxEventsExceededError,
  ReplayDivergenceError,
  RUN_ERROR_CODES,
  type RunErrorCode,
  RunExpiredError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { once, setWorkflowBasePath } from '@workflow/utils';
import {
  parseWorkflowName,
  workflowDisplayName,
} from '@workflow/utils/parse-name';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  type EventResult,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  getQueueTopicPrefix,
  type HookResumeTiming,
  IN_BAND_SEQ_AT_RUN_CREATION,
  isSealedNoopEvent,
  isTerminalWorkflowRunStatus,
  type RunInput,
  resolveQueueNamespace,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  slotToEventId,
  type WorkflowInvokePayload,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import ms from 'ms';
import { decodeTime } from 'ulid';
import {
  classifyRunError,
  isRetryableWorldError,
  isWorldContractError,
} from './classify-error.js';
import { describeError } from './describe-error.js';
import type { WorkflowSuspension } from './global.js';
import { type Logger, runtimeLogger } from './logger.js';
import { getStepFunction } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { COMPUTE_INSTANCE_ID } from './runtime/compute-instance.js';
import {
  DYNAMIC_WORKFLOWS_ENV,
  getMaxEventsOverride,
  getMaxInlineSteps,
  getMaxQueueDeliveries,
  getOpenWaitClockSkewMs,
  getReplayDivergenceMaxRetries,
  getRunAheadDepth,
  isDynamicWorkflowsEnabled,
  isOptimisticInlineStartExplicitlyDisabled,
  isTurboEnabled,
  isVmRetentionEnabled,
} from './runtime/constants.js';
import {
  type DeploymentAffinityOutcome,
  guardDeploymentAffinity,
  type ReenqueueArgs,
} from './runtime/deployment-guard.js';
import {
  type DynamicWorkflowMetadata,
  dynamicWorkflowName,
  readDynamicWorkflowMetadata,
} from './runtime/dynamic-workflow.js';
import {
  type EventCreator,
  findEventSlotGap,
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  isQueueSendFailure,
  isSlotGapCheckEnabled,
  type LoadedEventLog,
  loadWorkflowRunEvents,
  maxEventSlot,
  memoizeEncryptionKey,
  mergeReportedEvents,
  parseHealthCheckPayload,
  queueMessage,
  queueMessages,
  REPLAY_RESOLVE_DATA,
  resolveRunEncryptionKey,
  rootRunIdFrom,
  runDispatchContext,
  type SlotSnapshotParams,
  settleEventSlotGap,
  slotSnapshotParams,
  stepDispatchIdempotencyKey,
  withHealthCheck,
} from './runtime/helpers.js';
import { withRunInputs } from './runtime/invocations.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
} from './runtime/lifecycle-hooks.js';
import { consumeOwnResolvingWrite } from './runtime/orchestrator/consume-after-commit.js';
import {
  forgetConsumedPosition,
  hasConsumedPosition,
  isNoopDelivery,
  recordConsumedPosition,
} from './runtime/orchestrator/consumed-position.js';
import {
  schedulesWaitTimer,
  stepsToReenqueue,
} from './runtime/orchestrator/creator-rules.js';
import {
  getInlineStepDeadlineMarginMs,
  mayStartInlineStep,
} from './runtime/orchestrator/deadline.js';
import {
  getFenceRedeliveryDelaySeconds,
  InBandWriter,
  OrchestratorSupersededError,
  RESILIENT_START_SNAPSHOT,
  requireLoadSnapshot,
} from './runtime/orchestrator/in-band-writer.js';
import {
  getOrchestratorPollIntervalMs,
  LiveLogFeed,
} from './runtime/orchestrator/live-feed.js';
import {
  analyzeLogSteps,
  dueWaits,
  type InlineStepSpec,
  MAX_STEP_MESSAGE_INPUT_BYTES,
  nextTimerAt,
  openWaits,
  type StepMessageSpec,
} from './runtime/orchestrator/log-state.js';
import {
  disableRunAheadFor,
  isRunAheadDisabledFor,
  type RunAheadContext,
  RunAheadStopError,
  runAheadContextFor,
  runAheadHazard,
} from './runtime/orchestrator/run-ahead.js';
import { stepMessageRetentionSeconds } from './runtime/orchestrator/step-retention.js';
import {
  type CreatedStep,
  planStepsAndWaits,
  type StartedInBatch,
} from './runtime/orchestrator/step-wait-creation.js';
import { observeOutOfBandWriters } from './runtime/out-of-band-observation.js';
import {
  handleReplayBudgetExhausted,
  ReplayBudget,
} from './runtime/replay-budget.js';
import { ReplayRecoveryReporter } from './runtime/replay-recovery-reporter.js';
import {
  resumeTimingForMessage,
  resumeTrackingFromMessage,
} from './runtime/resume-latency.js';
import { runIdCreatedAt } from './runtime/run-id-time.js';
import {
  DEFAULT_STEP_MAX_RETRIES,
  executeStep,
} from './runtime/step-executor.js';
import { handleStepMessage } from './runtime/step-handler.js';
import { computeStepLatencyTracking } from './runtime/step-latency.js';
import { runStepSingleFlight } from './runtime/step-single-flight.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import { useQuickJSVm } from './runtime/vm-mode.js';
import { getWaitContinuationDispatch } from './runtime/wait-continuation.js';
import { getWorld } from './runtime/world.js';
import {
  dehydrateRunError,
  hydrateDynamicWorkflowCode,
  type PayloadKey,
} from './serialization.js';
import { setErrorStack } from './set-error-stack.js';
import { remapErrorStack } from './source-map.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import {
  bindActiveTraceContext,
  buildInvocationSpanLinks,
  getNextTraceCarrier,
  getSpanKind,
  getWorkflowTraceMode,
  isUsableTraceCarrier,
  trace,
  withTraceContext,
  withWorkflowBaggage,
} from './telemetry.js';
import {
  formatErrorCauseChain,
  getErrorName,
  getErrorStack,
  normalizeUnknownError,
} from './types.js';
import { buildWorkflowSuspensionMessage } from './util.js';
import {
  compileDynamicWorkflowBundle,
  compileWorkflowBundle,
  replayWorkflow,
  resumeWorkflow,
  type WorkflowResumeResult,
  type WorkflowSession,
} from './workflow.js';

export type { Event, WorkflowRun };
export { WorkflowSuspension } from './global.js';
export {
  type HealthCheckOptions,
  type HealthCheckResult,
  healthCheck,
} from './runtime/helpers.js';
export {
  getHookByToken,
  type Hook,
  type ResumedHook,
  resumeHook,
  resumeWebhook,
} from './runtime/resume-hook.js';
export {
  getRun,
  Run,
  type WorkflowReadableStream,
  type WorkflowReadableStreamOptions,
  type WorkflowRunWritableStreamOptions,
} from './runtime/run.js';
export {
  type CancelRunOptions,
  cancelRun,
  cancelRuns,
  listStreams,
  pendingWakeUpWaits,
  type ReadStreamOptions,
  type RecreateRunOptions,
  type ReenqueueRunOptions,
  readStream,
  recreateRunFromExisting,
  reenqueueRun,
  type StopSleepOptions,
  type StopSleepResult,
  wakeUpRun,
} from './runtime/runs.js';
export {
  type DynamicStartOptions,
  type DynamicWorkflowOptions,
  type DynamicWorkflowStepReference,
  type StartOptions,
  type StartOptionsBase,
  type StartOptionsWithDeploymentId,
  type StartOptionsWithoutDeploymentId,
  start,
} from './runtime/start.js';
export {
  createWorld,
  createWorldFromModule,
  getWorld,
  getWorldHandlers,
  setWorld,
  type WorldFactoryModule,
} from './runtime/world.js';

/**
 * Apply the optional client-side event-limit override.
 * `WORKFLOW_MAX_EVENTS_OVERRIDE`, when set to a positive integer, clamps the
 * server-supplied per-run event ceiling to a smaller value so enforcement can
 * be exercised without a server-side change. Clamp-down only: it never raises
 * the server's limit, and it takes effect even when the server returns none.
 * Unset ⇒ server value passes through unchanged.
 */
/**
 * `promise`, with a handler attached so a rejection nobody else observes (a
 * step spec that ends up not run) does not surface as unhandled. Whoever
 * awaits it still sees the rejection.
 */
function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * The `run_created` a turbo delivery holds without loading the log: what
 * `start()` wrote at the first position, rebuilt from the run input the
 * message carries. Replay consumes `run_created` structurally, so only its
 * identity and creation data matter.
 */
function turboRunCreatedEvent(runId: string, input: RunInput): Event {
  return {
    eventId: slotToEventId(FIRST_EVENT_SLOT),
    runId,
    eventType: 'run_created',
    specVersion: input.specVersion ?? SPEC_VERSION_CURRENT,
    createdAt: new Date(runIdCreatedAt(runId) ?? Date.now()),
    eventData: {
      deploymentId: input.deploymentId,
      workflowName: input.workflowName,
      input: input.input,
      ...(input.executionContext
        ? { executionContext: input.executionContext }
        : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
    },
  } as Event;
}

/** The executor's view of a `step_started` a creation batch committed. */
function startedFromBatch(
  started: StartedInBatch | undefined
): InlineStepSpec['started'] {
  return started
    ? {
        startedAt: new Date(started.event.createdAt),
        postSentAtMs: started.postSentAtMs,
        completedAtMs: started.completedAtMs,
      }
    : undefined;
}

function clampMaxEvents(serverValue: number | undefined): number | undefined {
  const override = getMaxEventsOverride();
  if (override === undefined) return serverValue;
  return serverValue === undefined ? override : Math.min(serverValue, override);
}

/**
 * Refuse a queue delivery whose run was created in a different environment than
 * this deployment runs in.
 *
 * `start()` performs two writes that must land in the same tenant: the
 * `run_created` event, attributed to whatever environment the *caller*
 * authenticates as, and the queue message, pinned to a *deployment*. A
 * misconfigured caller can split them, writing the run to one environment
 * while addressing the message to a deployment in another. The consumer then
 * finds no run under its own tenant and the backend's resilient start
 * (`run_started` creates the run when `run_created` was never seen) mints a
 * SECOND copy of the same run id in this environment. Both copies are real: the
 * creator's sits pending forever, this one executes, and every subsequent
 * cross-tenant queue ack fails to find its message.
 *
 * Nothing external is needed to catch this: the creator's environment rides the
 * message in `runInput.environment` and this process already knows its own. So
 * compare them and stop BEFORE `run_started`, the write that would create the
 * fork. Refusing after it would be too late.
 *
 * Returns `true` when the caller must abandon the delivery. Skipped whenever
 * either side is unknown, which keeps every existing setup on its current
 * behavior: worlds with no environment dimension (`world-local`,
 * `world-postgres`) don't implement `getEnvironment`, and runs started by an
 * older SDK carry no `environment` field.
 */
function refuseCrossEnvironmentDelivery({
  world,
  runInput,
  runId,
  runLogger,
}: {
  world: World;
  runInput: RunInput | undefined;
  runId: string;
  runLogger: Logger;
}): boolean {
  const creatorEnvironment = runInput?.environment;
  if (!creatorEnvironment) return false;

  const currentEnvironment = world.getEnvironment?.();
  if (!currentEnvironment || currentEnvironment === creatorEnvironment) {
    return false;
  }

  runLogger.error(
    `Refusing to run this workflow: it was created in the "${creatorEnvironment}" ` +
      `environment but this deployment runs in "${currentEnvironment}". ` +
      'Executing it here would create a second copy of the same run id in ' +
      'both environments — one pending forever, one running — so the queue ' +
      'message is being discarded without executing and without retrying. ' +
      'The client that called start() wrote the run to its own environment ' +
      'but addressed the queue message to a deployment in another one. Check ' +
      'that the environment that client authenticates as (WORKFLOW_VERCEL_ENV ' +
      "for CLI and CI clients, or the OIDC token's environment inside a " +
      'deployment) matches the environment of the deployment it targets. The ' +
      `run it created is still pending in "${creatorEnvironment}" and will ` +
      'not run.',
    {
      workflowRunId: runId,
      creatorEnvironment,
      currentEnvironment,
      pinnedDeploymentId: runInput?.deploymentId,
    }
  );
  return true;
}

/**
 * Log when a `start()`-enqueued message pinned to one deployment is delivered
 * to a different one.
 *
 * A first-delivery message carries `runInput.deploymentId` (the deployment
 * `start()` addressed it to), so comparing that against this handler's own
 * deployment detects mis-delivery directly. This is a DIAGNOSTIC, not a gate:
 * it warns and lets the invocation proceed, deliberately.
 *
 * Why this one only warns while its environment sibling above refuses: a
 * differing deployment id is not by itself evidence of the fork we care about.
 * The environment pair is exact (two named environments that disagree) and it
 * is the dimension the run's tenant is keyed on. Deployment ids disagree for
 * benign reasons too: `world-local` derives its id from the installed package
 * version (`dpl_local@<version>`), so upgrading the SDK mid-run changes it with
 * nothing wrong. Refusing on that signal would strand correct runs, and
 * refusing before `run_started` leaves no server-side record to explain why.
 * Anyone tempted to promote this to a hard failure has to handle that first.
 *
 * Skipped unless BOTH ids are known: `getDeploymentId()` throws in worlds that
 * require a deployment and have none, and a re-enqueued message carries no
 * `runInput` at all.
 */
async function warnOnDeploymentPinningMismatch({
  world,
  runInput,
  runId,
  runLogger,
}: {
  world: World;
  runInput: RunInput | undefined;
  runId: string;
  runLogger: Logger;
}): Promise<void> {
  const pinnedDeploymentId = runInput?.deploymentId;
  if (!pinnedDeploymentId) return;

  let currentDeploymentId: string | undefined;
  try {
    currentDeploymentId = await world.getDeploymentId();
  } catch {
    // Worlds that require a deployment id throw when there isn't one. That is
    // not a mismatch: there is nothing to compare against.
    return;
  }
  if (!currentDeploymentId || currentDeploymentId === pinnedDeploymentId) {
    return;
  }

  runLogger.error(
    'Queue message was delivered to a deployment it was not pinned to. ' +
      'The run was created targeting a different deployment, so this ' +
      'invocation may be replaying against code the run was not started on. ' +
      'Continuing — this is expected if the Workflow SDK version changed ' +
      'mid-run in local development, where the deployment id is derived from ' +
      'that version.',
    {
      workflowRunId: runId,
      pinnedDeploymentId,
      currentDeploymentId,
    }
  );
}

function getWorkflowSetupErrorCode(err: unknown): RunErrorCode | null {
  if (WorkflowRuntimeError.is(err)) {
    return RUN_ERROR_CODES.RUNTIME_ERROR;
  }

  if (isWorldContractError(err)) {
    return RUN_ERROR_CODES.WORLD_CONTRACT_ERROR;
  }

  return null;
}

async function recordFatalRunError({
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
        specVersion: SPEC_VERSION_CURRENT,
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

function findRecordedTerminalRunEvent(
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

function hasRecordedTerminalRunEvent(events: Event[], runId: string): boolean {
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

type RetentionDecision =
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
function getRetentionDecision({
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

/**
 * Maximum inline-execution duration for a single handler invocation.
 *
 * Order of precedence:
 * 1. `WORKFLOW_V2_TIMEOUT_MS` env var
 * 2. Tiered budget derived from `world.getRuntimeDeadline()`
 * 3. Default of 2 minutes
 */
async function getMaxInlineDurationMs(
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

/** The workflow code a delivery replays, and the marker when it is dynamic. */
interface ResolvedWorkflowCode {
  code: string;
  dynamicWorkflow?: DynamicWorkflowMetadata;
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
async function resolveWorkflowCodeForRun(
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

/**
 * Creates a single route which handles workflow execution requests,
 * executing steps inline when possible to reduce function invocations
 * and queue overhead.
 *
 * The handler loops: replay workflow → execute step inline → replay → ...
 * until the workflow completes, times out, or encounters non-step suspensions.
 *
 * @param workflowCode - The workflow bundle code containing all workflow functions
 * @returns A function that can be used as a Vercel API route
 */
export function workflowEntrypoint(
  workflowCode: string,
  options?: {
    namespace?: string;
    routeModuleBodyStartedAt?: number;
    basePath?: string;
  }
): (req: Request) => Promise<Response> {
  setWorkflowBasePath(options?.basePath);

  const namespace = resolveQueueNamespace(options?.namespace);
  const workflowPrefix = getQueueTopicPrefix('workflow', namespace);

  const handler = (worldHandlers: World) =>
    worldHandlers.createQueueHandler(
      workflowPrefix,
      withRunInputs(worldHandlers)(async (message_, metadata) => {
        // T2 of the hook-resume TTR window (see runtime/resume-latency.ts):
        // the instant this consumer began, before message parsing. Only used
        // when the message turns out to carry resume timing; taking it
        // unconditionally keeps it honest for the deliveries that do.
        const handlerEnteredAtMs = Date.now();
        // Check if this is a health check message
        // NOTE: Health check messages are intentionally unauthenticated for monitoring purposes.
        // They only write a status response to a stream and do not expose sensitive data.
        // The stream name includes a unique correlationId that must be known by the caller.
        const healthCheck = parseHealthCheckPayload(message_);
        if (healthCheck) {
          await handleHealthCheckMessage(
            healthCheck,
            worldHandlers.specVersion
          );
          return;
        }

        const {
          runId,
          traceCarrier: incomingTraceCarrier,
          requestedAt,
          stepId: incomingStepId,
          stepName: incomingStepName,
          replayDivergence,
          deploymentMismatchRetryCount,
          runInput,
          hookInput,
          stepInput,
          stepAttempt,
          stepCreatedEventId,
          runContext,
          hookResumeTiming,
          waitContinuation,
          completeWaits,
        } = WorkflowInvokePayloadSchema.parse(message_);
        // Waits a `run.wakeUp()` asked this delivery to complete now,
        // whatever their `resumeAt`. Spent on the first pass that sees them.
        const wakeUpWaits = new Set(completeWaits ?? []);

        // --- Hook-resume TTR telemetry (runtime/resume-latency.ts) ---
        // Threaded through this invocation and CONSUMED by the first durable
        // step that follows the resumption, cleared at that point so a later
        // step, a retry, or a redelivery never re-reports the same resume.
        //
        // Two delivery shapes carry timing:
        //  - the resume's own invocation (no `stepId`): the producer's T0/T1
        //    ride the message and this handler's entry is T2.
        //  - a step this invocation handed to another invocation (`stepId`
        //    present): the resuming invocation already stamped T2..T4 onto
        //    the message, so they are read back verbatim.
        let resumeTracking = resumeTrackingFromMessage(
          hookResumeTiming,
          incomingStepId !== undefined ? 'dispatched' : 'inline'
        );
        if (resumeTracking && incomingStepId === undefined) {
          resumeTracking.consumerStartedAtMs = handlerEnteredAtMs;
        }
        if (
          resumeTracking &&
          !Number.isFinite(resumeTracking.consumerStartedAtMs)
        ) {
          // A step message from a producer that forwarded timing without the
          // consumer boundaries. Nothing additive can be reported.
          resumeTracking = undefined;
        }
        // `start()` always attaches a trace carrier, but
        // serializeTraceCarrier() returns `{}` when no OTEL SDK is registered
        // or no span is active, so treat an empty carrier the same as an
        // absent one so linked mode falls back to a fresh origin instead of
        // forwarding a useless `{}` forever.
        const traceContext = isUsableTraceCarrier(incomingTraceCarrier)
          ? incomingTraceCarrier
          : undefined;
        const { requestId } = metadata;
        const workflowName = metadata.queueName.slice(workflowPrefix.length);

        // --- Max delivery check ---
        // Enforce max delivery limit before any infrastructure calls.
        // This prevents runaway workflows from consuming infinite queue deliveries.
        // Scoped logger for this run: attaches runId/workflowName to every
        // log line and child loggers below, so callers don't repeat it.
        const runLogger = runtimeLogger.forRun(runId, workflowName);

        // A step message is exempt: it is retried in place for its whole
        // life (each userland retry is a redelivery), so its delivery count
        // is bounded by the step's retries and the message's retention.
        const maxQueueDeliveries = getMaxQueueDeliveries();
        if (metadata.attempt > maxQueueDeliveries && !incomingStepId) {
          const maxDeliveriesDescription = describeError(
            undefined,
            RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED
          );
          runLogger.error(
            `Workflow handler exceeded max deliveries (${metadata.attempt}/${maxQueueDeliveries})`,
            {
              attempt: metadata.attempt,
              errorCode: maxDeliveriesDescription.errorCode,
              errorAttribution: maxDeliveriesDescription.attribution,
            }
          );
          let encryptionKey: PayloadKey | undefined;
          let dehydratedError: Uint8Array;
          try {
            const world = await getWorld();
            const getEncryptionKey = memoizeEncryptionKey(world, runId);
            const err = new FatalError(
              `Workflow exceeded maximum queue deliveries (${metadata.attempt}/${maxQueueDeliveries})`
            );
            encryptionKey = await getEncryptionKey();
            dehydratedError = await dehydrateRunError(
              err,
              runId,
              encryptionKey
            );
            // The orchestrator's own terminal write, so in-band: load the log
            // for the fence count first. A step message never reaches here
            // (it is exempt from the cap).
            const loaded = await loadWorkflowRunEvents(runId);
            const writer = new InBandWriter(world, runId);
            writer.adoptSnapshot(requireLoadSnapshot(runId, loaded));
            await writer.create(
              {
                eventType: 'run_failed',
                specVersion: SPEC_VERSION_CURRENT,
                eventData: {
                  error: dehydratedError,
                  errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
                },
              },
              { requestId, ...slotSnapshotParams(loaded.events) }
            );
          } catch (err) {
            if (OrchestratorSupersededError.is(err)) {
              // Another orchestrator invocation is writing this run, so it
              // is not stuck; leave the run to it and consume this message.
              runLogger.info(
                'Max-deliveries failure superseded by a live orchestrator; acknowledging',
                { attempt: metadata.attempt }
              );
              return;
            }
            if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
              // Run already finished, consume the message silently
              return;
            }
            // A transient backend failure (429 / 5xx / transport) must not
            // abandon the run: acking here leaves it `running` with no message
            // left to drive it. Throw so the queue redelivers with its backoff
            // (honoring a 429's Retry-After); the redelivery is still past the
            // ceiling, so it only retries this terminal write, never the replay.
            // This relies on the World redelivering past the ceiling: VQS and
            // world-local do, while world-postgres currently caps its jobs at
            // exactly this delivery (#4427, fixed by #4428).
            if (isRetryableWorldError(err)) {
              runLogger.warn(
                'Transient error marking run as failed after max deliveries, retrying via queue redelivery',
                {
                  attempt: metadata.attempt,
                  errorName: err instanceof Error ? err.name : 'UnknownError',
                  errorMessage:
                    err instanceof Error ? err.message : String(err),
                }
              );
              throw err;
            }
            runLogger.error(
              `Failed to mark run as failed after ${metadata.attempt} delivery attempts. ` +
                `A persistent error is preventing the run from being terminated. ` +
                `The run will remain in its current state until manually resolved. ` +
                `This is most likely due to a persistent outage of the workflow backend ` +
                `or a bug in the workflow runtime and should be reported to the Workflow team.`,
              {
                attempt: metadata.attempt,
                errorName: err instanceof Error ? err.name : 'UnknownError',
                errorMessage: err instanceof Error ? err.message : String(err),
                errorStack: err instanceof Error ? err.stack : undefined,
              }
            );
            return;
          }
          dispatchRunFailedHooks(
            runId,
            workflowName,
            dehydratedError,
            encryptionKey,
            RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED
          );
          return;
        }

        // --- Trace correlation mode ---
        // 'linked' (default): the workflow.execute span below stays a CHILD
        // of the local delivery (flow-route) context, so one invocation
        // (route handler, workflow replay, inline steps, event writes) is a
        // single bounded trace. The run-origin context travels as a span
        // LINK (not a parent), and re-enqueues forward the original carrier
        // unchanged, so a (potentially hours-long) run is never stitched
        // into one giant trace across invocations.
        // 'continuous': legacy behavior, where the restored run-origin context
        // becomes the parent of this invocation's spans.
        const traceMode = getWorkflowTraceMode();

        // Trace carrier to attach to messages this invocation enqueues.
        // See getNextTraceCarrier for the linked/continuous semantics.
        const nextTraceCarrier = (): Promise<Record<string, string>> =>
          getNextTraceCarrier(traceMode, traceContext);

        // Span links to the incoming delivery context and (in linked mode)
        // the run-origin context from the trace carrier.
        const spanLinks = await buildInvocationSpanLinks(
          traceMode,
          traceContext
        );

        // The replay budget covers orchestration work between steps, not inline
        // step bodies. It is checked between loop iterations; step bodies use
        // the platform timeout and NO_INLINE_REPLAY_AFTER_MS guard instead.
        const replayBudget = new ReplayBudget();

        // In linked mode the run-origin context is NOT restored as the
        // active (parent) context: passing `undefined` makes
        // withTraceContext a passthrough, so the workflow.execute span below
        // stays a child of the local delivery (flow-route) context and the
        // run-origin travels as a span link instead.
        const parentTraceCarrier =
          traceMode === 'continuous' ? traceContext : undefined;
        // Queue-delivered invocation: CONSUMER kind, matching the
        // queue-delivered step.execute span.
        const spanKind = await getSpanKind('CONSUMER');
        return await withTraceContext(parentTraceCarrier, async () => {
          return await withWorkflowBaggage(
            { workflowRunId: runId, workflowName },
            async () => {
              const world = await trace('workflow.route.get_world', async () =>
                getWorld()
              );
              // Both checks below look at `runInput`, so both are no-ops on a
              // re-enqueued message (which carries none): they only ever run on
              // a first delivery, the one that could create the run.
              //
              // Returning acks the message. That is deliberate: the mismatch is
              // baked into this message, so every redelivery would reach the
              // same verdict, and throwing would hot-loop the handler until
              // MAX_QUEUE_DELIVERIES with the same error each time. It matches
              // how the run_started path already discards deliveries whose
              // verdict cannot change (EntityConflictError, RunExpiredError).
              if (
                refuseCrossEnvironmentDelivery({
                  world,
                  runInput,
                  runId,
                  runLogger,
                })
              ) {
                return;
              }
              // Diagnostic only. See the helper for why this warns instead of
              // refusing the invocation.
              await warnOnDeploymentPinningMismatch({
                world,
                runInput,
                runId,
                runLogger,
              });
              return trace(
                `workflow.execute ${workflowDisplayName(workflowName)}`,
                { kind: spanKind, links: spanLinks },
                async (span) => {
                  span?.setAttributes({
                    ...Attribute.WorkflowName(workflowName),
                    ...Attribute.WorkflowOperation('execute_v2'),
                    ...Attribute.MessagingSystem('vercel-queue'),
                    ...Attribute.MessagingDestinationName(metadata.queueName),
                    ...Attribute.MessagingMessageId(metadata.messageId),
                    ...Attribute.MessagingOperationType('process'),
                    ...getQueueOverhead({ requestedAt }),
                    ...Attribute.WorkflowRunId(runId),
                    ...Attribute.WorkflowTracePropagated(!!traceContext),
                    ...Attribute.WorkflowTraceMode(traceMode),
                  });

                  const invocationStartTime = Date.now();
                  const noInlineReplayAfterMs = await getMaxInlineDurationMs(
                    world,
                    invocationStartTime
                  );
                  let loopIteration = 0;
                  // Hooks whose force-claim victim wake this invocation has
                  // already sent (its own forced creations, and the replay's
                  // republishes), so each suspension of the loop below does
                  // not send them again. See `forcedCreationsOwingWake`.
                  const forceClaimVictimWakes = new Set<string>();
                  const replayRecoveryReporter = replayDivergence
                    ? new ReplayRecoveryReporter(replayDivergence.count)
                    : ReplayRecoveryReporter.inert();
                  // Compilation is useful only for the Node VM. Wait until the
                  // run's engine selection is known so QuickJS deliveries never
                  // parse and cache an unused node:vm Script. The promise is
                  // invocation-scoped and reused by every cold replay;
                  // evaluation still waits for a fresh VM context.
                  let compiledWorkflowScripts:
                    | ReturnType<typeof compileWorkflowBundle>
                    | undefined;
                  let compiledWorkflowName: string | undefined;
                  const startWorkflowCompile = await bindActiveTraceContext(
                    (
                      workflow?: Pick<
                        WorkflowRun,
                        'workflowName' | 'executionContext'
                      >
                    ) => {
                      if (!workflow || useQuickJSVm(workflow)) return;
                      // A dynamic run does not replay the deployment's
                      // bundle, and its own code is not available yet (it is
                      // encrypted, and resolving it needs the run's key). Skip
                      // the warm-up rather than cache scripts the replay must
                      // not use: `replayWorkflow` compiles the resolved code
                      // itself when no compiled scripts are handed to it.
                      if (
                        readDynamicWorkflowMetadata(workflow.executionContext)
                      ) {
                        return;
                      }
                      if (compiledWorkflowName !== workflow.workflowName) {
                        compiledWorkflowName = workflow.workflowName;
                        compiledWorkflowScripts = compileWorkflowBundle(
                          workflowCode,
                          workflow.workflowName
                        );
                        // Terminal runs can return without awaiting compilation.
                        void compiledWorkflowScripts.catch(() => {});
                      }
                      return compiledWorkflowScripts;
                    }
                  );
                  const encryptionKey = once(() => {
                    const result = resolveRunEncryptionKey(world, runId);
                    void result.catch(() => {});
                    return result;
                  });
                  let replayPayloadCache: ReplayPayloadCache | undefined;
                  const startReplayPayloadCache = (
                    workflow?: Pick<WorkflowRun, 'executionContext'>
                  ) => {
                    if (!workflow || useQuickJSVm(workflow)) return;
                    if (!replayPayloadCache) {
                      replayPayloadCache = new ReplayPayloadCache(
                        encryptionKey.value
                      );
                    }
                    return replayPayloadCache;
                  };
                  const prepareReplayEvent = (event: Event): void => {
                    if (event.eventType === 'run_created') {
                      startReplayPayloadCache(event.eventData);
                      startWorkflowCompile(event.eventData);
                    }
                    replayPayloadCache?.prepareEvent(event);
                  };
                  // Every in-band write of this delivery goes through one
                  // writer, which marks it in-band, carries the fence count
                  // taken from the delivery's full log load, and stops the
                  // delivery for good once the World refuses it as
                  // superseded.
                  const writer = new InBandWriter(world, runId);
                  // Turbo mode fast-paths the first delivery of the run's
                  // first orchestrator message: the one `start()` enqueued,
                  // the only one that carries `runInput`, on its first
                  // delivery. On it the log holds only `run_created` (or
                  // nothing, when `run_created` never landed), and no other
                  // orchestrator of the run can exist yet. So it writes
                  // `run_started` without waiting for it, replays against an
                  // empty log without loading it (the in-band count after the
                  // run's creation is known), and starts inline step bodies
                  // before their `step_created`/`step_started` commit. A
                  // redelivery (`{ timeoutSeconds }` after a fence refusal
                  // included) has a delivery count above 1 and takes the
                  // normal path, which loads the log.
                  const turbo =
                    isTurboEnabled() &&
                    runInput !== undefined &&
                    metadata.attempt === 1 &&
                    (metadata.deliveryCount ?? 1) === 1 &&
                    !incomingStepId &&
                    !replayDivergence &&
                    !hookInput &&
                    !waitContinuation;
                  span?.setAttributes(Attribute.WorkflowTurbo(turbo));
                  /**
                   * Turbo only: settles once the backgrounded `run_started`
                   * landed, and rejects with its error if it failed. Every
                   * in-band write queues behind `run_started` in `writer`,
                   * which stops for good if it fails. Writes made outside the
                   * writer (an optimistic step body's stream and attribute
                   * writes, an out-of-band `run_failed`) wait on this.
                   * `undefined` outside turbo, where `run_started` is awaited.
                   */
                  let runReadyBarrier: Promise<void> | undefined;
                  /** Turbo only: the backgrounded `run_started` write. */
                  let turboRunStarted: Promise<EventResult> | undefined;
                  /**
                   * Turbo only: the backgrounded `run_started`, once it
                   * committed and until it joined the log.
                   */
                  let turboStartLanded: EventResult | undefined;
                  /** Turbo only: the backgrounded `run_started` failed. */
                  let turboStartFailure: { error: unknown } | undefined;
                  /**
                   * Whether turbo still starts inline step bodies before
                   * their start commits. Ends for the rest of the delivery
                   * once a suspension has a hook or a wait; an explicit
                   * `WORKFLOW_OPTIMISTIC_INLINE_START=0` keeps it off.
                   */
                  let turboOptimistic =
                    turbo && !isOptimisticInlineStartExplicitlyDisabled();
                  // Orders a write made outside the in-band writer after the
                  // backgrounded `run_started`. Swallows its failure: the
                  // callers stop the delivery on their own (a guard hand-off
                  // or a setup failure). No-op outside turbo.
                  const awaitRunReady = async (): Promise<void> => {
                    await runReadyBarrier?.catch(() => {});
                  };
                  // The loaded event log. `undefined` until the delivery's
                  // first full load.
                  let log: LoadedEventLog | undefined;
                  /**
                   * The slot snapshot for a write: how much of the log the
                   * decision behind it was made against. Understating is safe
                   * (the World reports a wider span), so it is taken from
                   * whatever is loaded.
                   */
                  const slotSnapshot = (): SlotSnapshotParams =>
                    log
                      ? slotSnapshotParams(
                          speculativeSlots.size === 0
                            ? log.events
                            : log.events.filter((event) => {
                                const slot = eventIdToSlot(event.eventId);
                                return (
                                  slot === null || !speculativeSlots.has(slot)
                                );
                              })
                        )
                      : {};
                  /**
                   * Run-ahead: slots of the speculative step outcomes in the
                   * log, handed to the workflow before their writes commit
                   * (see `writeOutcomeAhead`). A write never names one as
                   * held: it may still turn out to be another writer's.
                   */
                  const speculativeSlots = new Set<number>();
                  /**
                   * Run-ahead: a speculative write committed somewhere other
                   * than where the workflow consumed it. Benign (only events
                   * the boundary's classification calls inert can have pushed
                   * it), but the log and the retained VM hold the wrong
                   * position for it, so the delivery reloads the log and
                   * replays fresh once its speculative writes settle. Writes
                   * are not folded into the log meanwhile.
                   */
                  let runAheadRepair = false;
                  // Set when an accepted write could not be folded into the
                  // log without leaving a hole; the next pass reads first.
                  let logBehind = false;
                  // Slots of this delivery's accepted in-band writes, and the
                  // highest slot the latest replay pass consumed. Any other
                  // event above that slot reached the log after the VM
                  // decided, so the delivery must not suspend past it.
                  const ownSlots = new Set<number>();
                  let passConsumedSlot = 0;
                  /**
                   * Folds an accepted in-band write into the loaded log: its
                   * skipped-slot report, then its own event, in position
                   * order. Nothing out-of-band can sit between the two except
                   * what the report names, so the log stays a prefix of the
                   * run's log, and the next replay needs no read for this
                   * delivery's own writes. A truncated or incomplete report
                   * is not merged; the gap check before the next replay then
                   * reloads.
                   */
                  const absorbWrite = (result: {
                    event?: Event;
                    events?: Event[];
                    hasMore?: boolean;
                    reportIncomplete?: boolean;
                  }): void => {
                    // Turbo: the backgrounded `run_started` precedes every
                    // other write of the delivery, so it joins the log first.
                    // Its report carries `run_created`; without the two, every
                    // later write would leave a hole below it.
                    const landed = turboStartLanded;
                    if (landed && landed !== result) {
                      turboStartLanded = undefined;
                      absorbWrite(landed);
                    } else if (landed) {
                      turboStartLanded = undefined;
                    }
                    if (!log || !result.event) return;
                    if (
                      result.reportIncomplete ||
                      result.hasMore ||
                      runAheadRepair
                    ) {
                      logBehind = true;
                      return;
                    }
                    const own = result.event;
                    const report = (result.events ?? []).filter(
                      (event) => event.eventId !== own.eventId
                    );
                    const below = Math.max(
                      maxEventSlot(log.events) ?? 0,
                      maxEventSlot(report) ?? 0
                    );
                    const ownSlot = eventIdToSlot(own.eventId);
                    if (ownSlot !== null && ownSlot > below + 1) {
                      // Something sits between what this delivery holds and
                      // its own write that the World did not report: read it
                      // before the next replay rather than leave a hole.
                      logBehind = true;
                      return;
                    }
                    if (ownSlot !== null) ownSlots.add(ownSlot);
                    // Merged events take the same payload preparation as
                    // loaded ones (decryption, decompression); replay reads
                    // their payloads through the same cache.
                    for (const event of report) prepareReplayEvent(event);
                    prepareReplayEvent(own);
                    mergeReportedEvents(log.events, [...report, own]);
                  };
                  /** A write's events, with their payloads prepared for replay. */
                  const preparedResult = <R extends EventResult>(
                    result: R
                  ): R => {
                    for (const event of result.events ?? []) {
                      prepareReplayEvent(event);
                    }
                    if (result.event) prepareReplayEvent(result.event);
                    return result;
                  };
                  /** The in-band writer, folding each accepted write into the log. */
                  const writeInBand: EventCreator = async (data, params) => {
                    const result = await writer.create(data, {
                      ...slotSnapshot(),
                      ...params,
                    });
                    absorbWrite(result);
                    return result;
                  };
                  const createEvent = async <T extends CreateEventRequest>(
                    data: T,
                    params?: CreateEventParams
                  ) =>
                    replayRecoveryReporter.withEventCreate(
                      {
                        ...slotSnapshot(),
                        resolveData: REPLAY_RESOLVE_DATA,
                        ...params,
                      },
                      (p) => writeInBand(data, p)
                    );
                  /** Full load: replaces the log and adopts its fence snapshot. */
                  const fullLoad = async (): Promise<LoadedEventLog> => {
                    const loaded = await loadWorkflowRunEvents(runId);
                    for (const event of loaded.events) {
                      prepareReplayEvent(event);
                    }
                    logBehind = false;
                    // Throws a World contract error for a log without a
                    // snapshot, except a resilient start's empty one.
                    writer.adoptSnapshot(requireLoadSnapshot(runId, loaded));
                    log = { events: loaded.events, cursor: loaded.cursor };
                    return log;
                  };
                  /**
                   * Incremental load from the log's cursor. Merged in slot
                   * order, since the log may already hold this delivery's
                   * own writes above the cursor.
                   */
                  const loadAfter = async (): Promise<LoadedEventLog> => {
                    logBehind = false;
                    if (!log || log.cursor === null) return fullLoad();
                    const page = await loadWorkflowRunEvents(runId, log.cursor);
                    for (const event of page.events) {
                      prepareReplayEvent(event);
                    }
                    mergeReportedEvents(log.events, page.events);
                    log.cursor = page.cursor ?? log.cursor;
                    return log;
                  };

                  let workflowRun: WorkflowRun | undefined;
                  // Server-supplied per-run event ceiling, from the
                  // `run_started` response of the delivery that wrote it.
                  let maxEventsLimit: number | undefined =
                    clampMaxEvents(undefined);
                  let workflowStartedAt = -1;
                  // Latency telemetry (TTFS / STSO / RSFS), see
                  // runtime/step-latency.ts: whether this invocation's first
                  // load held nothing beyond the run's own creation and start,
                  // and when the `run_started` this delivery wrote returned.
                  let invocationStartedClean: boolean | undefined;
                  let runStartedReceivedAtMs: number | undefined;
                  let preStepBlockingMs = 0;

                  const recordWorkflowSetupFailure = async (
                    err: unknown
                  ): Promise<boolean> => {
                    const errorCode = getWorkflowSetupErrorCode(err);
                    if (!errorCode) return false;
                    // Turbo: the out-of-band `run_failed` follows the
                    // backgrounded `run_started`. If that failed, this
                    // delivery writes nothing: its error decides instead.
                    if (runReadyBarrier) await runReadyBarrier;
                    await recordFatalRunError({
                      world,
                      workflowRun,
                      runId,
                      workflowName,
                      requestId,
                      err,
                      errorCode,
                      logMessage: 'Fatal runtime error during workflow setup',
                    });
                    return true;
                  };

                  // A plain orchestrator wake. Omits `runInput` and the
                  // recovery counters of this delivery chain.
                  const replayMessage =
                    async (): Promise<WorkflowInvokePayload> => ({
                      runId,
                      traceCarrier: await nextTraceCarrier(),
                      requestedAt: new Date(),
                    });
                  /** Unkeyed wake of this run's orchestrator. */
                  const wakeSelf = async (
                    extra?: Partial<WorkflowInvokePayload>,
                    delaySeconds?: number
                  ): Promise<void> => {
                    await queueMessage(
                      world,
                      getWorkflowQueueName(workflowName, namespace),
                      { ...(await replayMessage()), ...extra },
                      delaySeconds !== undefined && delaySeconds > 0
                        ? { delaySeconds }
                        : undefined
                    );
                  };

                  // Deployment-affinity guard, shared by the two paths that
                  // execute a run: queued step executions and flow replays.
                  const guardDeployment = async (
                    run: Pick<
                      WorkflowRun,
                      'runId' | 'deploymentId' | 'specVersion'
                    >,
                    reenqueuePayload: () => Promise<WorkflowInvokePayload>,
                    beforeStop?: () => Promise<void>,
                    writeEvent?: EventCreator
                  ): Promise<DeploymentAffinityOutcome> => {
                    const { outcome, spanAttributes } =
                      await guardDeploymentAffinity({
                        world,
                        run,
                        workflowName,
                        requestId,
                        retryCount: deploymentMismatchRetryCount,
                        beforeStop,
                        writeEvent,
                        isDeploymentUnavailableError:
                          world.isDeploymentUnavailableError,
                        reenqueue: async ({
                          deploymentId,
                          specVersion,
                          deploymentMismatchRetryCount: retryCount,
                          delaySeconds,
                        }: ReenqueueArgs) => {
                          await queueMessage(
                            world,
                            getWorkflowQueueName(workflowName, namespace),
                            {
                              ...(await reenqueuePayload()),
                              deploymentMismatchRetryCount: retryCount,
                            },
                            { deploymentId, specVersion, delaySeconds }
                          );
                        },
                      });
                    if (spanAttributes) span?.setAttributes(spanAttributes);
                    return outcome;
                  };

                  // A message with a stepId is a background step's own
                  // message. Its invocation runs the body and reports the
                  // outcome; it never replays the workflow.
                  if (incomingStepId && incomingStepName) {
                    const stepResumeTracking = resumeTracking;
                    resumeTracking = undefined;
                    try {
                      return await handleStepMessage({
                        world,
                        runId,
                        workflowName,
                        namespace,
                        requestId,
                        payload: {
                          stepId: incomingStepId,
                          stepName: incomingStepName,
                          stepAttempt,
                          stepInput,
                          stepCreatedEventId,
                          runContext,
                        },
                        meta: metadata,
                        resumeTracking: stepResumeTracking,
                        span,
                        nextTraceCarrier,
                        guardDeployment: async (run) =>
                          (await guardDeployment(run, async () => ({
                            ...(await replayMessage()),
                            stepId: incomingStepId,
                            stepName: incomingStepName,
                            ...(stepAttempt ? { stepAttempt } : {}),
                            ...(stepInput ? { stepInput } : {}),
                            ...(stepCreatedEventId
                              ? { stepCreatedEventId }
                              : {}),
                            ...(runContext ? { runContext } : {}),
                            ...(hookResumeTiming ? { hookResumeTiming } : {}),
                          }))) === 'continue',
                      });
                    } catch (err) {
                      const errorCode = getWorkflowSetupErrorCode(err);
                      if (!errorCode) {
                        throw err;
                      }
                      await recordFatalRunError({
                        world,
                        workflowRun,
                        runId,
                        workflowName,
                        requestId,
                        err,
                        errorCode,
                        logMessage:
                          'Fatal error while preparing background workflow step',
                      });
                      return;
                    }
                  }

                  // --- Orchestrator delivery ---
                  // A delivery with nothing new since the position this
                  // process last consumed, and no due timer, exits without a
                  // replay. Only consulted when this process holds a
                  // position for the run, so a miss costs nothing.
                  // A timer delivery is excluded: one that arrives before its
                  // wait is due (a long sleep spans several queue hops) has
                  // to arm the next hop, which a no-op exit would skip.
                  if (
                    !runInput &&
                    !hookInput &&
                    !replayDivergence &&
                    !waitContinuation &&
                    wakeUpWaits.size === 0 &&
                    hasConsumedPosition(world, runId)
                  ) {
                    const tail = await world.events.list({
                      runId,
                      pagination: { sortOrder: 'desc', limit: 1 },
                      resolveData: 'none',
                    });
                    const tailId = tail.data[0]?.eventId;
                    const tailSlot =
                      tailId === undefined
                        ? undefined
                        : (eventIdToSlot(tailId) ?? undefined);
                    if (
                      isNoopDelivery({
                        world,
                        runId,
                        tailSlot,
                        nowMs: Date.now(),
                      })
                    ) {
                      span?.setAttributes(Attribute.WorkflowNoopDelivery(true));
                      runtimeLogger.debug(
                        'Nothing new since the last consumed position; acknowledging without a replay',
                        { workflowRunId: runId, tailSlot }
                      );
                      return;
                    }
                  }

                  try {
                    return await orchestrate();
                  } catch (caught) {
                    // A failed turbo `run_started` decides the delivery, as
                    // a failed awaited `run_started` does on the normal path,
                    // whatever later write surfaced it.
                    const err = turboStartFailure
                      ? turboStartFailure.error
                      : caught;
                    if (
                      OrchestratorSupersededError.is(err) ||
                      writer.isSuperseded
                    ) {
                      forgetConsumedPosition(world, runId);
                      const timeoutSeconds = getFenceRedeliveryDelaySeconds();
                      // Expected under overlap (a stalled invocation, or a
                      // transport retry of a write that already committed),
                      // so not an error.
                      runtimeLogger.info(
                        'Orchestrator superseded by another invocation of the run; redelivering this message',
                        {
                          workflowRunId: runId,
                          loopIteration,
                          timeoutSeconds,
                          expectedSeqInBand: writer.expectedSeqInBand,
                        }
                      );
                      span?.setAttributes(Attribute.WorkflowSuperseded(true));
                      return { timeoutSeconds };
                    }
                    if (
                      RunAheadStopError.is(err) ||
                      RunAheadStopError.is(writer.stopCause)
                    ) {
                      forgetConsumedPosition(world, runId);
                      const timeoutSeconds = getFenceRedeliveryDelaySeconds();
                      runtimeLogger.info(
                        'Run-ahead stopped before writing from a speculative state; redelivering this message',
                        {
                          workflowRunId: runId,
                          reason: RunAheadStopError.is(err)
                            ? err.reason
                            : (writer.stopCause as RunAheadStopError).reason,
                          timeoutSeconds,
                        }
                      );
                      return { timeoutSeconds };
                    }
                    if (turboStartFailure) {
                      if (
                        EntityConflictError.is(err) ||
                        RunExpiredError.is(err)
                      ) {
                        runtimeLogger.info(
                          'Run already finished during setup, skipping',
                          {
                            workflowRunId: runId,
                            message: (err as Error).message,
                          }
                        );
                        return undefined;
                      }
                      // Nothing else of this delivery reached the World, so
                      // a setup error can still be recorded.
                      runReadyBarrier = undefined;
                      if (await recordWorkflowSetupFailure(err)) {
                        return undefined;
                      }
                    }
                    throw err;
                  }

                  /**
                   * `run_started` for this delivery. On a first delivery
                   * it carries the creation data from `runInput`, so a
                   * World that never saw `run_created` creates the run
                   * from it (resilient start).
                   */
                  function runStartedRequest() {
                    return {
                      eventType: 'run_started' as const,
                      specVersion:
                        runInput?.specVersion ?? SPEC_VERSION_CURRENT,
                      ...(runInput
                        ? {
                            eventData: {
                              input: runInput.input,
                              deploymentId: runInput.deploymentId,
                              workflowName: runInput.workflowName,
                              executionContext: runInput.executionContext,
                              attributes: runInput.attributes,
                              allowReservedAttributes:
                                runInput.allowReservedAttributes,
                              dynamicWorkflowCode: runInput.dynamicWorkflowCode,
                              dynamicWorkflowCodeRef:
                                runInput.dynamicWorkflowCodeRef,
                            },
                          }
                        : {}),
                    };
                  }

                  /**
                   * Turbo setup: writes `run_started` in the background and
                   * returns the run synthesized from `runInput`. The log is
                   * empty, and the fence count is the one right after the
                   * run's creation, which is what a load would have found.
                   */
                  function startTurbo(input: RunInput): WorkflowRun {
                    writer.adoptSnapshot({
                      seq: FIRST_EVENT_SLOT,
                      seqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
                    });
                    // The log as the World holds it: the run's creation at the
                    // first position (a resilient start's `run_started`
                    // creates it there too). Writes of this delivery then
                    // join it in position order from the first one, whether
                    // or not the World reports what lies below them.
                    log = {
                      events: [turboRunCreatedEvent(runId, input)],
                      cursor: null,
                    };
                    span?.addEvent('workflow.run_started.create.start', {
                      'workflow.run_started.skip_preload': true,
                    });
                    // Nothing reads this response's log page: the write is
                    // a barrier, and its own event and skipped-slot report
                    // are folded into the log like any in-band write's.
                    const started = writer.createRequired(runStartedRequest(), {
                      requestId,
                      skipPreload: true,
                      resolveData: REPLAY_RESOLVE_DATA,
                    });
                    turboRunStarted = started;
                    runReadyBarrier = started.then(
                      (result) => {
                        turboStartLanded = result;
                        const limit = clampMaxEvents(result.maxEvents);
                        if (limit !== undefined) maxEventsLimit = limit;
                      },
                      (error: unknown) => {
                        turboStartFailure = { error };
                        throw error;
                      }
                    );
                    // Observed by every gated write; this only keeps an
                    // early failure from surfacing as unhandled.
                    runReadyBarrier.catch(() => {});
                    const now = new Date();
                    // The run as `run_started` will have made it. Seed
                    // attributes ride in `runInput` (they live on
                    // `run_created`, not in `attr_set` events), so the
                    // snapshot carries them although the log is not loaded.
                    // This holds while attributes are write-only inside a
                    // workflow: an in-workflow read API would have to read
                    // this snapshot, not replay `run_created`/`attr_set`, or
                    // it would see no seed attributes on this delivery only.
                    // A dynamic run's code rides the message for the same
                    // reason; without it (too large to send inline)
                    // `resolveWorkflowCodeForRun` reads it from the run.
                    return {
                      runId,
                      status: 'running',
                      deploymentId: input.deploymentId,
                      workflowName: input.workflowName,
                      specVersion: input.specVersion,
                      executionContext: input.executionContext,
                      input: input.input,
                      ...(input.dynamicWorkflowCode
                        ? { dynamicWorkflowCode: input.dynamicWorkflowCode }
                        : {}),
                      attributes: input.attributes ?? {},
                      startedAt: now,
                      createdAt: now,
                      updatedAt: now,
                    } as WorkflowRun;
                  }

                  async function orchestrate(): Promise<
                    { timeoutSeconds: number } | undefined
                  > {
                    let run: WorkflowRun | undefined;
                    if (turbo && runInput) {
                      run = startTurbo(runInput);
                      try {
                        startWorkflowCompile(runInput);
                        startReplayPayloadCache(runInput);
                        for (const event of log?.events ?? []) {
                          prepareReplayEvent(event);
                        }
                      } catch (err) {
                        // Recorded behind the backgrounded `run_started`.
                        if (!(await recordWorkflowSetupFailure(err))) throw err;
                        return undefined;
                      }
                      // Turbo synthesizes the run before the response that
                      // would anchor RSFS, so the synthesis anchors it.
                      runStartedReceivedAtMs = +(run.startedAt as Date);
                      if (resumeTracking) {
                        resumeTracking.setupSource = 'run_started';
                      }
                      // AUTHORITATIVE deployment-affinity protection, before
                      // replay or inline step execution. Both of its
                      // stopping actions hand the run off, so they wait for
                      // the backgrounded `run_started` first.
                      if (
                        (await guardDeployment(
                          run,
                          replayMessage,
                          awaitRunReady,
                          writeInBand
                        )) !== 'continue'
                      ) {
                        return undefined;
                      }
                    } else {
                      // --- Run setup: full load (with the fence snapshot) ---
                      const [loadOutcome, runOutcome] =
                        await Promise.allSettled([
                          fullLoad(),
                          world.runs.get(runId, { resolveData: 'none' }),
                        ]);
                      run =
                        runOutcome.status === 'fulfilled'
                          ? (runOutcome.value as WorkflowRun)
                          : undefined;
                      if (!run) {
                        if (!runInput) {
                          throw runOutcome.status === 'rejected'
                            ? runOutcome.reason
                            : new WorkflowRuntimeError(
                                `Workflow run "${runId}" not found`
                              );
                        }
                        // Resilient start: `run_created` never landed, and this
                        // first delivery carries what the World needs to create
                        // the run from `run_started`. A load that failed left no
                        // snapshot; the run holds no in-band position yet.
                        log = { events: [], cursor: null };
                        if (!writer.hasSnapshot) {
                          writer.adoptSnapshot(RESILIENT_START_SNAPSHOT);
                        }
                      } else if (loadOutcome.status === 'rejected') {
                        // A World contract error on the log load fails the run
                        // (out-of-band, since there is no fence snapshot); any
                        // other load failure redelivers.
                        workflowRun ??= run;
                        if (
                          await recordWorkflowSetupFailure(loadOutcome.reason)
                        ) {
                          return undefined;
                        }
                        throw loadOutcome.reason;
                      }
                      if (run && isTerminalWorkflowRunStatus(run.status)) {
                        runtimeLogger.info(
                          'Workflow already completed or failed, skipping',
                          { workflowRunId: runId, status: run.status }
                        );
                        return undefined;
                      }
                      assert(log, 'The event log is loaded before setup');
                      // AUTHORITATIVE deployment-affinity protection, before
                      // this delivery writes anything (`run_started` included)
                      // and before replay or inline step execution.
                      if (
                        run &&
                        (await guardDeployment(
                          run,
                          async () => ({
                            ...(await replayMessage()),
                            ...(hookInput ? { hookInput } : {}),
                            ...(hookResumeTiming ? { hookResumeTiming } : {}),
                          }),
                          undefined,
                          // The log is loaded, so the orchestrator's own
                          // DEPLOYMENT_MISMATCH failure is written in-band.
                          writeInBand
                        )) !== 'continue'
                      ) {
                        return undefined;
                      }
                      const hasRunStarted = log.events.some(
                        (event) => event.eventType === 'run_started'
                      );
                      if (!hasRunStarted) {
                        try {
                          startWorkflowCompile(runInput);
                          startReplayPayloadCache(runInput);
                          span?.addEvent('workflow.run_started.create.start', {
                            'workflow.run_started.skip_preload': false,
                          });
                          const started = await createEvent(
                            runStartedRequest(),
                            {
                              requestId,
                            }
                          );
                          run = started.run ?? run;
                          maxEventsLimit = clampMaxEvents(started.maxEvents);
                          runStartedReceivedAtMs = Date.now();
                          if (resumeTracking) {
                            resumeTracking.setupSource = 'run_started';
                          }
                        } catch (err) {
                          if (
                            EntityConflictError.is(err) ||
                            RunExpiredError.is(err)
                          ) {
                            runtimeLogger.info(
                              'Run already finished during setup, skipping',
                              { workflowRunId: runId, message: err.message }
                            );
                            return undefined;
                          }
                          if (!(await recordWorkflowSetupFailure(err))) {
                            throw err;
                          }
                          return undefined;
                        }
                        // The log now holds the run's own start (and, after a
                        // resilient start, its creation).
                        await fullLoad();
                      } else if (resumeTracking) {
                        resumeTracking.setupSource = 'event_load';
                      }
                    }
                    assert(run, 'Workflow run must be loaded before replay');
                    assert(log, 'The event log is loaded before replay');
                    invocationStartedClean = log.events.every(
                      (e) =>
                        e.eventType === 'run_created' ||
                        e.eventType === 'run_started' ||
                        e.eventType === 'attr_set' ||
                        isSealedNoopEvent(e)
                    );
                    const runCreated = log.events.find(
                      (event) => event.eventType === 'run_created'
                    );
                    // A log without `run_created` (a legacy run, or a World
                    // whose log starts later) takes the input from the run.
                    let runInputValue: unknown;
                    try {
                      runInputValue = runCreated
                        ? runCreated.eventData.input
                        : turbo && runInput
                          ? runInput.input
                          : (
                              await world.runs.get(runId, {
                                resolveData: 'all',
                              })
                            ).input;
                    } catch (err) {
                      if (!(await recordWorkflowSetupFailure(err))) throw err;
                      return undefined;
                    }
                    const runStarted = log.events.find(
                      (event) => event.eventType === 'run_started'
                    );
                    workflowRun = {
                      ...run,
                      input: runInputValue,
                      status: 'running',
                      output: undefined,
                      error: undefined,
                      completedAt: undefined,
                      startedAt:
                        run.startedAt ?? runStarted?.createdAt ?? new Date(),
                    } as WorkflowRun;
                    workflowStartedAt = +(workflowRun.startedAt as Date);
                    startWorkflowCompile(workflowRun);
                    span?.setAttributes({
                      ...Attribute.WorkflowRunStatus('running'),
                      ...Attribute.WorkflowStartedAt(workflowStartedAt),
                    });

                    // Legacy lazy hook resume: an older producer sent the
                    // payload on this message only. The orchestrator writes
                    // the `hook_received` itself (in-band), deduplicated by
                    // `resumeId`.
                    if (
                      hookInput &&
                      !log.events.some(
                        (event) =>
                          event.eventType === 'hook_received' &&
                          event.resumeId === hookInput.resumeId
                      )
                    ) {
                      let occurredAt: Date | undefined;
                      try {
                        occurredAt = new Date(decodeTime(hookInput.resumeId));
                      } catch {
                        occurredAt = undefined;
                      }
                      try {
                        await createEvent(
                          {
                            eventType: 'hook_received',
                            specVersion: SPEC_VERSION_CURRENT,
                            correlationId: hookInput.hookId,
                            eventData: {
                              token: hookInput.token,
                              payload: hookInput.payload,
                            },
                          },
                          {
                            requestId,
                            occurredAt,
                            resumeId: hookInput.resumeId,
                            resumePayloadDigest: hookInput.payloadDigest,
                          }
                        );
                        span?.setAttributes(
                          Attribute.HookResilientResumeMaterialized(true)
                        );
                      } catch (err) {
                        if (
                          HookNotFoundError.is(err) ||
                          RunExpiredError.is(err)
                        ) {
                          return undefined;
                        }
                        throw err;
                      }
                      await loadAfter();
                    }

                    let resolvedWorkflowCode: ResolvedWorkflowCode;
                    try {
                      resolvedWorkflowCode = await resolveWorkflowCodeForRun(
                        workflowCode,
                        workflowRun,
                        () => encryptionKey.value,
                        world,
                        async () => {}
                      );
                    } catch (err) {
                      if (!(await recordWorkflowSetupFailure(err))) {
                        throw err;
                      }
                      return undefined;
                    }
                    const effectiveWorkflowCode = resolvedWorkflowCode.code;
                    const dynamicWorkflowMetadata =
                      resolvedWorkflowCode.dynamicWorkflow;
                    if (dynamicWorkflowMetadata) {
                      span?.setAttributes({
                        ...Attribute.WorkflowDynamic(true),
                        ...Attribute.WorkflowDynamicSourceHash(
                          dynamicWorkflowMetadata.sourceHash
                        ),
                      });
                      runLogger.info('Executing stored dynamic workflow code', {
                        sourceHash: dynamicWorkflowMetadata.sourceHash,
                      });
                    }
                    const dynamicWorkflowScripts =
                      dynamicWorkflowMetadata && !useQuickJSVm(workflowRun)
                        ? compileDynamicWorkflowBundle(
                            effectiveWorkflowCode,
                            workflowRun.workflowName
                          )
                        : undefined;

                    // --- QuickJS VM engine dispatch ---
                    if (useQuickJSVm(workflowRun)) {
                      const { runWorkflowWithQuickJS } = await import(
                        './runtime/quickjs-entrypoint.js'
                      );
                      try {
                        const quickjsResult = await runWorkflowWithQuickJS({
                          workflowCode: effectiveWorkflowCode,
                          workflowName,
                          workflowRun,
                          preloadedEvents: log.events,
                          preloadedEventsComplete: true,
                          preloadedCursor: log.cursor,
                          runInput,
                          parentSpan: span,
                          maxEventsLimit,
                          namespace,
                          nextTraceCarrier,
                          waitContinuation,
                          deliveryAttempt: metadata.deliveryCount,
                          ownerMessageId: metadata.messageId,
                          requestId,
                          writer,
                          ...(wakeUpWaits.size > 0 ? { wakeUpWaits } : {}),
                          ...(turboRunStarted && runReadyBarrier
                            ? {
                                turbo: {
                                  runStarted: turboRunStarted,
                                  runReadyBarrier,
                                  optimistic: turboOptimistic,
                                },
                              }
                            : {}),
                        });
                        if (quickjsResult?.timeoutSeconds !== undefined) {
                          await wakeSelf(
                            undefined,
                            quickjsResult.timeoutSeconds
                          );
                        }
                        return undefined;
                      } catch (err) {
                        if (
                          OrchestratorSupersededError.is(err) ||
                          turboStartFailure ||
                          isRetryableWorldError(err) ||
                          isQueueSendFailure(err)
                        ) {
                          throw err;
                        }
                        return await failRun(err, effectiveWorkflowCode);
                      }
                    }

                    let session: WorkflowSession | null = null;
                    const continuedHookIds = new Set<string>();

                    // Inline steps run as background work of this delivery,
                    // so the VM keeps advancing (a due timer, a hook payload,
                    // a sibling's outcome) while a body runs. Their writes
                    // and the live feed's events are buffered and folded into
                    // the log only between passes, never under a replay.
                    type InlineSettled = {
                      spec: InlineStepSpec;
                      outcome: PromiseSettledResult<
                        Awaited<ReturnType<typeof executeStep>>
                      >;
                    };
                    const inFlight = new Map<string, Promise<void>>();
                    // Every step whose body this delivery started. A body can
                    // settle while a pass replays, before its outcome is
                    // folded in, and that pass must not read the step as an
                    // unfinished inline step to run again.
                    const ranInline = new Set<string>();
                    /**
                     * Whether a live-feed event is this delivery's own write
                     * echoed back, so it brings the workflow nothing new: a
                     * slot its own write was answered with, an event of one of
                     * its inline steps (only this delivery writes those), or
                     * one already in the log.
                     */
                    const isOwnEvent = (event: Event): boolean => {
                      const slot = eventIdToSlot(event.eventId);
                      if (slot !== null && ownSlots.has(slot)) return true;
                      // Turbo: the run's creation and this delivery's
                      // backgrounded start, echoed before they joined the log.
                      if (
                        turbo &&
                        (event.eventType === 'run_created' ||
                          event.eventType === 'run_started')
                      ) {
                        return true;
                      }
                      if (
                        event.eventType.startsWith('step_') &&
                        event.correlationId !== undefined &&
                        ranInline.has(event.correlationId)
                      ) {
                        return true;
                      }
                      return (
                        log?.events.some((e) => e.eventId === event.eventId) ??
                        false
                      );
                    };
                    const settledInline: InlineSettled[] = [];
                    // Turbo: creation commits still in flight while the bodies
                    // they create run (see `optimisticCreation`).
                    const creationsInFlight = new Set<Promise<unknown>>();
                    // The longest backoff of the inline starts this delivery
                    // had refused for load. Once every body has settled the
                    // delivery defers the run by it.
                    let throttledSeconds: number | undefined;
                    const pendingAbsorbs: Array<
                      Parameters<typeof absorbWrite>[0]
                    > = [];
                    const pendingFeedEvents: Event[] = [];
                    let liveFeed: LiveLogFeed | undefined;
                    // Timer messages this delivery already sent, by wait and
                    // `resumeAt`.
                    const armedTimers = new Set<string>();
                    // Set when an inline step finished with stream writes
                    // still flushing; the delivery hands off once no body runs.
                    let pendingStreamOps = false;
                    type InlineProgress =
                      | {
                          type: 'return';
                          result: { timeoutSeconds: number } | undefined;
                        }
                      | { type: 'reload-full' }
                      | { type: 'continue'; retainSession: boolean };
                    let progressDirty = false;
                    let progressWaiter: (() => void) | undefined;
                    const notifyProgress = (): void => {
                      progressDirty = true;
                      const waiter = progressWaiter;
                      progressWaiter = undefined;
                      waiter?.();
                    };
                    /** Folds buffered feed events and inline writes into the log. */
                    const flushPending = (): void => {
                      if (!log) return;
                      if (turboStartLanded) absorbWrite(turboStartLanded);
                      if (pendingFeedEvents.length > 0) {
                        const events = pendingFeedEvents
                          .splice(0)
                          .filter((event) => {
                            const slot = eventIdToSlot(event.eventId);
                            if (slot !== null) writer.observeSlot(slot);
                            checkRunAheadHazard(event, 'live feed');
                            // A speculative position is the delivery's own
                            // until its write confirms or repairs it.
                            if (slot !== null && speculativeSlots.has(slot)) {
                              const own = speculationsBySlot.get(slot);
                              if (
                                own &&
                                (own.event.eventType !== event.eventType ||
                                  own.event.correlationId !==
                                    event.correlationId)
                              ) {
                                runAheadRepair = true;
                              }
                              return false;
                            }
                            return !runAheadRepair;
                          });
                        for (const event of events) prepareReplayEvent(event);
                        mergeReportedEvents(log.events, events);
                      }
                      if (pendingAbsorbs.length > 0) {
                        const results = pendingAbsorbs.splice(0);
                        results.sort(
                          (a, b) =>
                            (eventIdToSlot(a.event?.eventId ?? '') ?? 0) -
                            (eventIdToSlot(b.event?.eventId ?? '') ?? 0)
                        );
                        for (const result of results) absorbWrite(result);
                      }
                    };
                    /** Waits for the next settle, feed event or due timer. */
                    const waitForProgress = async (): Promise<void> => {
                      if (progressDirty) {
                        progressDirty = false;
                        return;
                      }
                      const timer = log ? nextTimerAt(log.events) : {};
                      const delayMs =
                        timer.nextTimerAtMs === undefined
                          ? undefined
                          : Math.max(0, timer.nextTimerAtMs - Date.now());
                      let handle: ReturnType<typeof setTimeout> | undefined;
                      await new Promise<void>((resolve) => {
                        progressWaiter = resolve;
                        if (delayMs !== undefined) {
                          handle = setTimeout(resolve, delayMs);
                        }
                      });
                      if (handle) clearTimeout(handle);
                      progressWaiter = undefined;
                      progressDirty = false;
                    };
                    /** Lets every running inline body settle; stops the feed. */
                    const drainInline = async (): Promise<void> => {
                      while (inFlight.size > 0) {
                        await Promise.allSettled([...inFlight.values()]);
                      }
                      // Speculative outcome writes settle before the delivery
                      // ends, whichever way it ends.
                      await settleRunAhead();
                      liveFeed?.stop();
                      liveFeed = undefined;
                    };

                    /**
                     * Whether the log holds an event above what the latest
                     * pass consumed that this delivery did not write.
                     */
                    const hasUnconsumedForeignEvent = (
                      events: readonly Event[]
                    ): boolean =>
                      events.some((event) => {
                        const slot = eventIdToSlot(event.eventId);
                        return (
                          slot !== null &&
                          slot > passConsumedSlot &&
                          !ownSlots.has(slot) &&
                          !speculativeSlots.has(slot) &&
                          event.eventType !== 'noop'
                        );
                      });

                    // --- Run-ahead (runtime/out-of-band-observation.ts) ---
                    // At a boundary whose classification is inert, an inline
                    // step's outcome is handed to the workflow as soon as its
                    // body returns, while its `step_completed`/`step_failed`
                    // is still in flight, so consecutive steps overlap their
                    // writes. At most `runAheadDepth` such writes are
                    // unconfirmed at once. Every write still goes through the
                    // in-band writer in decision order, and a speculative one
                    // is a required write: any failure stops the writer, so
                    // nothing is written from a speculative state after it.
                    // Only a World that stores an in-band write at the time
                    // the orchestrator chose can show the workflow that time
                    // before the write commits (`inBandEventTime`).
                    const runAheadDepth =
                      world.capabilities?.inBandEventTime === true &&
                      !isRunAheadDisabledFor(world)
                        ? getRunAheadDepth()
                        : 0;
                    /** A speculative write in flight, by the slot it holds. */
                    type Speculation = {
                      event: Event;
                      settled: Promise<void>;
                    };
                    /**
                     * Steps whose speculative outcome is in flight: the steps
                     * the workflow has moved past without a confirmed write.
                     * `runAheadDepth` bounds them.
                     */
                    const unconfirmedOutcomes = (): Set<string> =>
                      new Set(
                        [...speculationsBySlot.values()].flatMap((s) =>
                          (s.event.eventType === 'step_completed' ||
                            s.event.eventType === 'step_failed') &&
                          s.event.correlationId
                            ? [s.event.correlationId]
                            : []
                        )
                      );
                    /**
                     * Whether the delivery may run ahead: of the outcomes of
                     * `stepIds` within the depth, or (without ids) start new
                     * steps ahead of their creation's commit while the
                     * outcomes in flight are within it.
                     */
                    const withinRunAheadDepth = (
                      stepIds: readonly string[] = []
                    ): boolean => {
                      if (
                        runAheadRepair ||
                        runAheadFailure !== undefined ||
                        writer.isStopped
                      ) {
                        return false;
                      }
                      const steps = unconfirmedOutcomes();
                      for (const id of stepIds) steps.add(id);
                      return steps.size <= runAheadDepth;
                    };
                    const speculationsBySlot = new Map<number, Speculation>();
                    /** Set when a speculative write failed; the delivery stops. */
                    let runAheadFailure: unknown;
                    /**
                     * The classifications under which speculative writes are
                     * in flight: what may and may not land below them.
                     */
                    const runAheadContexts = new Set<RunAheadContext>();
                    const runAheadStats = {
                      runAhead: 0,
                      drained: 0,
                      depthCap: 0,
                      failureStops: 0,
                      hazardStops: 0,
                    };
                    const outOfBandBoundaries = {
                      inert: 0,
                      observedHook: 0,
                      unknownHook: 0,
                      abortSignal: 0,
                      externalStep: 0,
                      waitDue: 0,
                    };
                    const recordRunAheadSpan = (): void => {
                      span?.setAttributes({
                        'workflow.out_of_band.inert_boundaries':
                          outOfBandBoundaries.inert,
                        'workflow.out_of_band.observed_hook_boundaries':
                          outOfBandBoundaries.observedHook,
                        'workflow.out_of_band.unknown_hook_boundaries':
                          outOfBandBoundaries.unknownHook,
                        'workflow.out_of_band.abort_signal_boundaries':
                          outOfBandBoundaries.abortSignal,
                        'workflow.out_of_band.external_step_boundaries':
                          outOfBandBoundaries.externalStep,
                        'workflow.out_of_band.wait_due_boundaries':
                          outOfBandBoundaries.waitDue,
                        'workflow.run_ahead.depth': runAheadDepth,
                        'workflow.run_ahead.boundaries': runAheadStats.runAhead,
                        'workflow.run_ahead.drained_boundaries':
                          runAheadStats.drained,
                        'workflow.run_ahead.depth_cap_steps':
                          runAheadStats.depthCap,
                        'workflow.run_ahead.failure_stops':
                          runAheadStats.failureStops,
                        'workflow.run_ahead.hazard_stops':
                          runAheadStats.hazardStops,
                      });
                    };
                    /**
                     * Stops the delivery on an event that lands below an
                     * unconfirmed speculative write and would have made the
                     * boundary it ran ahead of path-changing. The
                     * classification and the in-band fence rule this out, so
                     * it is loud: the writer stops before anything else is
                     * written, and the redelivery decides from the log.
                     */
                    function checkRunAheadHazard(
                      event: Event,
                      source: string
                    ): void {
                      if (speculationsBySlot.size === 0) return;
                      // Every step this delivery runs inline writes its own
                      // events; the hooks are those any boundary still in
                      // flight was sensitive to.
                      const sensitiveHookIds = new Set<string>();
                      const selfStepIds = new Set<string>([
                        ...ranInline,
                        ...inFlight.keys(),
                      ]);
                      for (const context of runAheadContexts) {
                        for (const id of context.sensitiveHookIds) {
                          sensitiveHookIds.add(id);
                        }
                        for (const id of context.selfStepIds) {
                          selfStepIds.add(id);
                        }
                      }
                      const reason = runAheadHazard(
                        event,
                        { sensitiveHookIds, selfStepIds },
                        isOwnOrKnownEvent
                      );
                      if (!reason) return;
                      runAheadStats.hazardStops++;
                      recordRunAheadSpan();
                      runLogger.warn(
                        'Run-ahead stopped: an event that could change the workflow landed below a speculative write',
                        {
                          reason,
                          source,
                          eventType: event.eventType,
                          eventId: event.eventId,
                          correlationId: event.correlationId,
                          speculativeSlots: [...speculativeSlots],
                        }
                      );
                      const stop = new RunAheadStopError(reason);
                      writer.halt(stop);
                      runAheadFailure ??= stop;
                      throw stop;
                    }
                    /**
                     * Whether `event` is this delivery's own write, or one the
                     * log already holds: neither can change the workflow.
                     */
                    function isOwnOrKnownEvent(event: Event): boolean {
                      const slot = eventIdToSlot(event.eventId);
                      if (slot !== null && speculativeSlots.has(slot)) {
                        // Another writer can hold a position the workflow
                        // consumed a speculative event at.
                        const own = speculationsBySlot.get(slot)?.event;
                        return (
                          own !== undefined &&
                          own.eventType === event.eventType &&
                          own.correlationId === event.correlationId
                        );
                      }
                      if (slot !== null && ownSlots.has(slot)) return true;
                      return (
                        log?.events.some((e) => e.eventId === event.eventId) ??
                        false
                      );
                    }
                    /** Waits for every speculative write in flight to settle. */
                    async function settleRunAhead(): Promise<void> {
                      while (speculationsBySlot.size > 0) {
                        await Promise.allSettled(
                          [...speculationsBySlot.values()].map((s) => s.settled)
                        );
                      }
                    }
                    /**
                     * Drains run-ahead before a decision that must not be
                     * taken from a speculative view: every speculative write
                     * settles, and a failure stops the delivery. Returns
                     * whether the log must be reloaded first.
                     */
                    async function drainRunAhead(): Promise<
                      'clean' | 'repair'
                    > {
                      await settleRunAhead();
                      if (runAheadFailure !== undefined) throw runAheadFailure;
                      writer.assertActive();
                      runAheadContexts.clear();
                      return runAheadRepair ? 'repair' : 'clean';
                    }
                    /** Replaces a repaired run-ahead's log with the World's. */
                    async function repairRunAhead(): Promise<void> {
                      await writer.idle();
                      runAheadRepair = false;
                      speculativeSlots.clear();
                      session = null;
                      await fullLoad();
                    }
                    /**
                     * Writes an inline step's outcome ahead: returns at once
                     * with the event the workflow consumes, at the slot the
                     * write takes unless another writer appends first, and
                     * with the time the World records for it (`occurredAt`).
                     * The commit is checked before any later write is sent.
                     */
                    function writeOutcomeAhead(
                      data: CreateEventRequest,
                      params: CreateEventParams | undefined,
                      context: RunAheadContext
                    ): EventResult {
                      const occurredAt = new Date();
                      const slot = writer.predictNextSlot();
                      const event = {
                        ...data,
                        runId,
                        eventId: slotToEventId(slot),
                        createdAt: occurredAt,
                      } as Event;
                      speculativeSlots.add(slot);
                      runAheadContexts.add(context);
                      const commit = writer.createRequired(
                        data,
                        {
                          ...params,
                          ...slotSnapshot(),
                          resolveData: REPLAY_RESOLVE_DATA,
                          occurredAt,
                        },
                        (result) => {
                          const committed = result.event;
                          for (const below of result.events ?? []) {
                            checkRunAheadHazard(below, 'skipped-slot report');
                          }
                          if (
                            !committed ||
                            +new Date(committed.createdAt) !== +occurredAt
                          ) {
                            // The World keeps its own time for in-band
                            // writes, so the workflow read a different
                            // `Date.now()` than replay will. Never again in
                            // this process for this World.
                            disableRunAheadFor(world);
                            throw new RunAheadStopError(
                              'the World does not record an in-band write at its occurredAt'
                            );
                          }
                          if (eventIdToSlot(committed.eventId) !== slot) {
                            runAheadRepair = true;
                          }
                        }
                      );
                      const settled = commit.then(
                        (result) => {
                          speculativeSlots.delete(slot);
                          speculationsBySlot.delete(slot);
                          if (!runAheadRepair) pendingAbsorbs.push(result);
                          notifyProgress();
                        },
                        (error: unknown) => {
                          speculationsBySlot.delete(slot);
                          if (runAheadFailure === undefined) {
                            runAheadStats.failureStops++;
                            recordRunAheadSpan();
                          }
                          runAheadFailure ??= error;
                          notifyProgress();
                        }
                      );
                      speculationsBySlot.set(slot, { event, settled });
                      return { event };
                    }
                    /**
                     * Writes a boundary's step creations (each new inline
                     * step's `step_created` and first `step_started`, one
                     * batch) ahead: their events join the log at the slots
                     * they take unless another writer appends first, and the
                     * bodies start at once. The commit is checked as an
                     * outcome's is (see {@link writeOutcomeAhead}).
                     */
                    function writeCreationAhead(
                      events: readonly CreateEventRequest[],
                      context: RunAheadContext
                    ): Map<string, StartedInBatch> {
                      assert(log, 'The event log is loaded to run ahead');
                      const occurredAt = new Date();
                      const first = writer.predictNextSlot();
                      const speculative = events.map(
                        (data, index) =>
                          ({
                            ...data,
                            runId,
                            eventId: slotToEventId(first + index),
                            createdAt: occurredAt,
                          }) as Event
                      );
                      runAheadContexts.add(context);
                      const postSentAtMs = Date.now();
                      const commit = writer.createBatchRequired(
                        events.map((event) => ({
                          event,
                          occurredAt,
                          ...(event.eventType === 'step_started'
                            ? { computeInstanceId: COMPUTE_INSTANCE_ID }
                            : {}),
                        })),
                        {
                          ...slotSnapshot(),
                          ...(requestId ? { requestId } : {}),
                        },
                        (result) => {
                          for (const below of result.events ?? []) {
                            checkRunAheadHazard(below, 'skipped-slot report');
                          }
                          result.results.forEach((item, index) => {
                            if (item.error !== undefined) {
                              throw new RunAheadStopError(
                                `a speculative ${events[index]?.eventType} was refused (${item.status}: ${item.message})`
                              );
                            }
                            if (
                              +new Date(item.event.createdAt) !== +occurredAt
                            ) {
                              disableRunAheadFor(world);
                              throw new RunAheadStopError(
                                'the World does not record an in-band write at its occurredAt'
                              );
                            }
                            if (
                              eventIdToSlot(item.event.eventId) !==
                              first + index
                            ) {
                              runAheadRepair = true;
                            }
                          });
                        }
                      );
                      const settled = commit.then(
                        (result) => {
                          speculative.forEach((_, index) => {
                            speculativeSlots.delete(first + index);
                            speculationsBySlot.delete(first + index);
                          });
                          if (!runAheadRepair) {
                            let firstItem = true;
                            for (const item of result.results) {
                              if (item.error !== undefined) continue;
                              pendingAbsorbs.push({
                                event: item.event,
                                ...(firstItem
                                  ? {
                                      events: result.events,
                                      reportIncomplete: result.reportIncomplete,
                                    }
                                  : {}),
                              });
                              firstItem = false;
                            }
                          }
                          notifyProgress();
                        },
                        (error: unknown) => {
                          speculative.forEach((_, index) => {
                            speculationsBySlot.delete(first + index);
                          });
                          if (runAheadFailure === undefined) {
                            runAheadStats.failureStops++;
                            recordRunAheadSpan();
                          }
                          runAheadFailure ??= error;
                          notifyProgress();
                        }
                      );
                      const starts = new Map<string, StartedInBatch>();
                      speculative.forEach((event, index) => {
                        speculativeSlots.add(first + index);
                        speculationsBySlot.set(first + index, {
                          event,
                          settled,
                        });
                        prepareReplayEvent(event);
                        if (
                          event.eventType === 'step_started' &&
                          event.correlationId
                        ) {
                          starts.set(event.correlationId, {
                            event,
                            postSentAtMs,
                            completedAtMs: postSentAtMs,
                          });
                        }
                      });
                      mergeReportedEvents(log.events, speculative);
                      return starts;
                    }
                    const inlineDeadlineMs =
                      invocationStartTime + noInlineReplayAfterMs;
                    const inlineMarginMs = getInlineStepDeadlineMarginMs();

                    // Main loop: replay, decide, write, run inline steps.
                    try {
                      while (true) {
                        loopIteration++;
                        assert(log, 'The event log is loaded in the loop');

                        if (replayBudget.isExhausted()) {
                          await handleReplayBudgetExhausted({
                            runId,
                            workflowName,
                            requestId,
                            attempt: metadata.attempt,
                            limitMs: replayBudget.configuredLimitMs,
                            slotSnapshot: slotSnapshot(),
                            writeEvent: (data, params) =>
                              writeInBand(data, params),
                          });
                          return undefined;
                        }

                        // Hand off before the function's deadline: the next
                        // delivery continues from the log.
                        if (Date.now() >= inlineDeadlineMs) {
                          runtimeLogger.info(
                            'Invocation deadline reached, handing the run to the next delivery',
                            {
                              workflowRunId: runId,
                              loopIteration,
                              elapsedMs: Date.now() - invocationStartTime,
                            }
                          );
                          await wakeSelf();
                          return undefined;
                        }

                        let replayStart = 0;
                        try {
                          if (runAheadRepair) {
                            await settleRunAhead();
                            if (runAheadFailure !== undefined) {
                              throw runAheadFailure;
                            }
                            await repairRunAhead();
                          }
                          flushPending();
                          if (logBehind) await loadAfter();
                          assert(log, 'The event log is loaded in the loop');
                          if (hasRecordedTerminalRunEvent(log.events, runId)) {
                            forgetConsumedPosition(world, runId);
                            return undefined;
                          }

                          // Complete elapsed waits. `wait_completed` resolves a
                          // promise, so it is consumed only after it commits,
                          // behind whatever its report says landed below it.
                          for (const wait of dueWaits(
                            log.events,
                            Date.now(),
                            wakeUpWaits
                          )) {
                            wakeUpWaits.delete(wait.correlationId);
                            const completed = await createEvent(
                              {
                                eventType: 'wait_completed' as const,
                                specVersion: SPEC_VERSION_CURRENT,
                                correlationId: wait.correlationId,
                                eventData: { resumeAt: wait.resumeAt },
                              },
                              { requestId }
                            );
                            if (
                              consumeOwnResolvingWrite(
                                log.events,
                                preparedResult(completed)
                              ).type === 'reload'
                            ) {
                              session = null;
                              await fullLoad();
                            }
                          }
                          assert(log, 'The event log is loaded in the loop');

                          if (isSlotGapCheckEnabled()) {
                            // Run-ahead places an outcome at the slot its write
                            // will take, so the log can hold it above a
                            // position this delivery's writer is still about
                            // to fill (a sibling step's start queued ahead of
                            // it). That is no hole: let the speculative writes
                            // and everything queued before them commit, and
                            // fold them in, before judging the log.
                            if (
                              speculationsBySlot.size > 0 &&
                              findEventSlotGap(log.events) !== undefined
                            ) {
                              if ((await drainRunAhead()) === 'repair') {
                                await repairRunAhead();
                              }
                              await writer.idle();
                              flushPending();
                            }
                            const settled = await settleEventSlotGap(runId, {
                              events: log.events,
                              cursor: log.cursor,
                            });
                            if (settled.log.events !== log.events) {
                              session = null;
                            }
                            log = {
                              events: settled.log.events,
                              cursor: settled.log.cursor,
                            };
                            if (settled.gap !== undefined) {
                              throw new CorruptedEventLogError(
                                `Event log for run ${runId} has a hole at slot ${settled.gap.firstMissingSlot}: ${settled.gap.missingCount} of the ${settled.gap.maxSlot} slots up to the log's maximum hold no event.`
                              );
                            }
                          }
                          if (hasRecordedTerminalRunEvent(log.events, runId)) {
                            forgetConsumedPosition(world, runId);
                            return undefined;
                          }

                          if (maxEventsLimit !== undefined) {
                            const workflowEventCount = log.events.reduce(
                              (n, e) => (isSealedNoopEvent(e) ? n : n + 1),
                              0
                            );
                            if (workflowEventCount >= maxEventsLimit) {
                              throw new MaxEventsExceededError(
                                workflowEventCount,
                                maxEventsLimit
                              );
                            }
                          }

                          runtimeLogger.debug('Starting workflow execution', {
                            workflowRunId: runId,
                            loopIteration,
                            eventCount: log.events.length,
                            executionMode: session ? 'retained' : 'replay',
                          });
                          replayStart = Date.now();
                          if (resumeTracking) {
                            resumeTracking.replayStartedAtMs ??= replayStart;
                          }
                          const replayPayloadCache =
                            startReplayPayloadCache(workflowRun);
                          assert(
                            replayPayloadCache,
                            'Node workflow replay requires payload preparation'
                          );
                          const payloadPrewarm = replayPayloadCache.prewarm(
                            workflowRun,
                            log.events
                          );
                          passConsumedSlot = maxEventSlot(log.events) ?? 0;
                          let workflowResult: WorkflowResumeResult = session
                            ? await resumeWorkflow(session, log.events)
                            : { type: 'replay' };
                          const servedByRetained =
                            session !== null &&
                            workflowResult.type !== 'replay';
                          if (workflowResult.type === 'replay') {
                            session = null;
                            const compiled = startWorkflowCompile(workflowRun);
                            assert(
                              compiled || dynamicWorkflowScripts,
                              'Node workflow replay requires compiled scripts'
                            );
                            workflowResult = await replayWorkflow({
                              workflowCode: effectiveWorkflowCode,
                              workflowRun,
                              events: log.events,
                              encryptionKey: await encryptionKey.value,
                              replayPayloadCache,
                              ...((compiled ?? dynamicWorkflowScripts)
                                ? {
                                    compiledWorkflowScripts: await (compiled ??
                                      dynamicWorkflowScripts),
                                  }
                                : {}),
                              worldCapabilities: world.capabilities,
                              writeEvent: (data, params) =>
                                writeInBand(data, params),
                            });
                          }
                          await payloadPrewarm;

                          if (workflowResult.type === 'completed') {
                            replayRecoveryReporter.activate();
                            let completed: EventResult;
                            try {
                              completed = await createEvent(
                                {
                                  eventType: 'run_completed',
                                  specVersion: SPEC_VERSION_CURRENT,
                                  eventData: { output: workflowResult.output },
                                },
                                { requestId }
                              );
                            } catch (err) {
                              if (
                                EntityConflictError.is(err) ||
                                RunExpiredError.is(err)
                              ) {
                                runtimeLogger.info(
                                  'Tried completing workflow run, but run has already finished.',
                                  { workflowRunId: runId, message: err.message }
                                );
                                return undefined;
                              }
                              throw err;
                            }
                            forgetConsumedPosition(world, runId);
                            // An out-of-band terminal event (a `run_cancelled`,
                            // or a `run_failed` from a step's invocation) can
                            // land below this one; the first terminal event by
                            // position decides the run. Only announce a
                            // completion the World recorded as the outcome.
                            const recordedStatus = completed.run?.status;
                            if (
                              recordedStatus !== undefined &&
                              recordedStatus !== 'completed'
                            ) {
                              runtimeLogger.info(
                                'Run reached another terminal state first; not dispatching completion hooks',
                                { workflowRunId: runId, status: recordedStatus }
                              );
                              return undefined;
                            }
                            dispatchRunCompletedHooks(runId, workflowName);
                            span?.setAttributes({
                              ...Attribute.WorkflowRunStatus('completed'),
                            });
                            return undefined;
                          }

                          replayRecoveryReporter.activate();
                          const suspension = workflowResult.suspension;
                          session = workflowResult.session;
                          if (resumeTracking && suspension.stepCount > 0) {
                            resumeTracking.nextStepEncounteredAtMs ??=
                              Date.now();
                          }
                          const suspensionMessage =
                            buildWorkflowSuspensionMessage(
                              suspension.stepCount,
                              suspension.hookCount,
                              suspension.waitCount
                            );
                          if (suspensionMessage) {
                            runtimeLogger.debug(suspensionMessage);
                          }

                          const outcome = await handleOrchestratorSuspension(
                            suspension,
                            workflowRun,
                            log,
                            Date.now() - replayStart,
                            servedByRetained
                          );
                          if (outcome.type === 'return') {
                            return outcome.result;
                          }
                          if (outcome.type === 'reload-full') {
                            session = null;
                            // A full load replaces the log, speculative
                            // events included: they settle first.
                            await settleRunAhead();
                            if (runAheadFailure !== undefined) {
                              throw runAheadFailure;
                            }
                            if (runAheadRepair) await repairRunAhead();
                            else await fullLoad();
                          } else if (outcome.type === 'reload') {
                            if (!outcome.retainSession) session = null;
                            await loadAfter();
                          } else if (!outcome.retainSession) {
                            session = null;
                          }
                        } catch (err) {
                          if (
                            OrchestratorSupersededError.is(err) ||
                            writer.isSuperseded ||
                            // A failed turbo `run_started` stopped every
                            // write; the delivery ends on its error.
                            turboStartFailure ||
                            // So did a speculative write that failed or
                            // failed its check.
                            RunAheadStopError.is(err) ||
                            RunAheadStopError.is(writer.stopCause) ||
                            runAheadFailure !== undefined
                          ) {
                            throw err;
                          }
                          if (
                            isRetryableWorldError(err) ||
                            isQueueSendFailure(err)
                          ) {
                            runLogger.warn(
                              'Transient world error during replay; redelivering via queue instead of failing the run',
                              {
                                errorName:
                                  err instanceof Error
                                    ? err.name
                                    : 'UnknownError',
                                errorMessage:
                                  err instanceof Error
                                    ? err.message
                                    : String(err),
                                deliveryAttempt: metadata.attempt,
                              }
                            );
                            throw err;
                          }
                          if (ReplayDivergenceError.is(err)) {
                            const recovery = await maybeRecoverDivergence(err);
                            if (recovery.type === 'queued') return undefined;
                            return await failRun(
                              recovery.error,
                              effectiveWorkflowCode,
                              recovery.divergenceCount,
                              recovery.logFields
                            );
                          }
                          if (replayStart > 0) {
                            replayRecoveryReporter.activate();
                          }
                          return await failRun(err, effectiveWorkflowCode);
                        }
                      }
                    } finally {
                      await drainInline();
                    }

                    /**
                     * Writes one suspension's decisions and runs what it
                     * runs inline. Returns how the loop continues.
                     */
                    async function handleOrchestratorSuspension(
                      suspension: WorkflowSuspension,
                      run: WorkflowRun,
                      loaded: LoadedEventLog,
                      replayDurationMs: number,
                      retained: boolean
                    ): Promise<
                      | {
                          type: 'return';
                          result: { timeoutSeconds: number } | undefined;
                        }
                      | { type: 'reload'; retainSession: boolean }
                      | { type: 'reload-full' }
                      | { type: 'continue'; retainSession: boolean }
                    > {
                      const compression =
                        (run.specVersion ?? 0) >=
                        SPEC_VERSION_SUPPORTS_COMPRESSION;
                      const hasAttributes = suspension.attributeCount > 0;
                      // The log as the replay saw it, before this
                      // suspension's own writes are folded in.
                      const replayedEvents = loaded.events.slice();

                      // Hooks, aborts, disposals and attribute writes.
                      const otherItems = suspension.items.filter(
                        (item) => item.type !== 'step' && item.type !== 'wait'
                      );
                      const hookAwaitingConflict = suspension.items.some(
                        (item) =>
                          item.type === 'hook' &&
                          !item.hasCreatedEvent &&
                          item.hasConflictAwaiter === true
                      );
                      if (runAheadFailure !== undefined) throw runAheadFailure;
                      writer.assertActive();

                      // --- Run-ahead gate ---
                      // Whether an event another writer could append now can
                      // change what this boundary leads to. Inert: the inline
                      // steps it schedules may hand their outcomes to the
                      // workflow before those commit. Not inert: nothing is
                      // decided from a speculative view, so the speculative
                      // writes in flight settle and their reports are taken
                      // in, in log order, before this boundary writes.
                      const gateRunnable = analyzeLogSteps(
                        replayedEvents
                      ).filter(
                        (step) =>
                          step.runnableInline &&
                          !ranInline.has(step.correlationId)
                      );
                      const gateMayInline =
                        !hookAwaitingConflict &&
                        mayStartInlineStep({
                          nowMs: Date.now(),
                          deadlineMs: inlineDeadlineMs,
                          marginMs: inlineMarginMs,
                        });
                      const gateSlots = gateMayInline
                        ? Math.max(
                            0,
                            getMaxInlineSteps() -
                              gateRunnable.length -
                              inFlight.size
                          )
                        : 0;
                      const gateNewSteps = suspension.items.flatMap((item) =>
                        item.type === 'step' && !item.hasCreatedEvent
                          ? [item.correlationId]
                          : []
                      );
                      const selfStepIds = new Set<string>([
                        ...ranInline,
                        ...inFlight.keys(),
                        ...gateRunnable.map((step) => step.correlationId),
                        ...gateNewSteps.slice(0, gateSlots),
                      ]);
                      const schedulesInline =
                        gateMayInline &&
                        (gateRunnable.length > 0 ||
                          (gateSlots > 0 && gateNewSteps.length > 0));
                      const waitWindowEndMs =
                        inlineDeadlineMs + getOpenWaitClockSkewMs();
                      const observation = observeOutOfBandWriters({
                        items: suspension.items,
                        observedHookIds: suspension.observedHookIds,
                        selfExecutedStepIds: selfStepIds,
                        waitDue:
                          openWaits(replayedEvents).some(
                            (wait) => wait.resumeAtMs <= waitWindowEndMs
                          ) ||
                          suspension.items.some(
                            (item) =>
                              item.type === 'wait' &&
                              +new Date(item.resumeAt) <= waitWindowEndMs
                          ),
                      });
                      let boundaryRunAhead: RunAheadContext | undefined;
                      if (schedulesInline) {
                        if (observation.inert) {
                          outOfBandBoundaries.inert++;
                        } else {
                          if (observation.observedHookCount > 0) {
                            outOfBandBoundaries.observedHook++;
                          }
                          if (observation.unknownHookCount > 0) {
                            outOfBandBoundaries.unknownHook++;
                          }
                          if (observation.abortSignalHookCount > 0) {
                            outOfBandBoundaries.abortSignal++;
                          }
                          if (observation.externalStepCount > 0) {
                            outOfBandBoundaries.externalStep++;
                          }
                          if (observation.waitDue)
                            outOfBandBoundaries.waitDue++;
                        }
                        if (runAheadDepth > 0 && observation.inert) {
                          runAheadStats.runAhead++;
                          boundaryRunAhead = runAheadContextFor({
                            observation,
                            hookItems: suspension.items.flatMap((item) =>
                              item.type === 'hook' ? [item] : []
                            ),
                            observedHookIds: suspension.observedHookIds,
                            selfStepIds,
                          });
                        } else if (runAheadDepth > 0) {
                          runAheadStats.drained++;
                        }
                        recordRunAheadSpan();
                      }
                      if (
                        !observation.inert &&
                        (speculationsBySlot.size > 0 || runAheadRepair)
                      ) {
                        if ((await drainRunAhead()) === 'repair') {
                          await repairRunAhead();
                          return { type: 'continue', retainSession: false };
                        }
                        flushPending();
                        // Something landed below the speculative writes:
                        // the workflow takes it in before this boundary.
                        if (log && hasUnconsumedForeignEvent(log.events)) {
                          return { type: 'continue', retainSession: true };
                        }
                      }
                      let hookResult:
                        | Awaited<ReturnType<typeof handleSuspension>>
                        | undefined;
                      if (otherItems.length > 0) {
                        try {
                          hookResult = await handleSuspension({
                            suspension: Object.assign(
                              Object.create(Object.getPrototypeOf(suspension)),
                              suspension,
                              { items: otherItems, steps: otherItems }
                            ) as WorkflowSuspension,
                            world,
                            run,
                            span,
                            requestId,
                            eventLog: loaded,
                            replayRecoveryReporter,
                            forceClaimVictimWakes,
                            writeEvent: (data, params) =>
                              writeInBand(data, params),
                          });
                        } catch (suspensionError) {
                          if (
                            OrchestratorSupersededError.is(suspensionError) ||
                            !FatalError.is(suspensionError)
                          ) {
                            throw suspensionError;
                          }
                          // Non-retryable, e.g. an attribute write the World
                          // rejected as invalid. Redelivery would hit it
                          // again, so fail the run.
                          return {
                            type: 'return',
                            result: await failRun(
                              suspensionError,
                              effectiveWorkflowCode
                            ),
                          };
                        }
                      }

                      // A hook write settles awaiters in the workflow itself
                      // (a conflict, an awaited registration). The workflow
                      // observes that before anything else this suspension
                      // would start, so continue over a reloaded log while
                      // each pass makes progress.
                      if (hookResult?.hasHookConflict) {
                        const fresh =
                          hookResult.hookConflictCorrelationIds.filter(
                            (id) => !continuedHookIds.has(id)
                          );
                        if (fresh.length > 0) {
                          for (const id of fresh) continuedHookIds.add(id);
                          return { type: 'reload', retainSession: true };
                        }
                        await wakeSelf();
                        return { type: 'return', result: undefined };
                      }
                      if (hasAttributes) {
                        // The committed `attr_set` decides races against the
                        // steps of the same pass, so nothing else is written
                        // until the next pass resolves it.
                        return { type: 'reload', retainSession: true };
                      }
                      if (hookResult?.hasAwaitedHookCreation) {
                        const fresh =
                          hookResult.awaitedHookCorrelationIds.filter(
                            (id) => !continuedHookIds.has(id)
                          );
                        if (fresh.length > 0) {
                          for (const id of fresh) continuedHookIds.add(id);
                          return { type: 'reload', retainSession: true };
                        }
                      }

                      // Steps and waits: decide each new step's execution
                      // mode, commit `step_created`/`wait_created`, then
                      // enqueue the background steps.
                      const logSteps = analyzeLogSteps(replayedEvents);
                      const runnableInline = logSteps.filter(
                        (step) =>
                          step.runnableInline &&
                          !ranInline.has(step.correlationId)
                      );
                      const mayInline =
                        !hookAwaitingConflict &&
                        mayStartInlineStep({
                          nowMs: Date.now(),
                          deadlineMs: inlineDeadlineMs,
                          marginMs: inlineMarginMs,
                        });
                      const inlineSlots = mayInline
                        ? Math.max(
                            0,
                            getMaxInlineSteps() -
                              runnableInline.length -
                              inFlight.size
                          )
                        : 0;
                      // Turbo stops starting bodies ahead of their start
                      // for the rest of the delivery once the run has a hook
                      // or a wait: a hook resume, a timer or `wakeUp()`
                      // gives the run writers other than this delivery.
                      // Attribute writes do not: they resolve in this
                      // process.
                      if (
                        turboOptimistic &&
                        suspension.items.some(
                          (item) =>
                            item.type !== 'step' && item.type !== 'attribute'
                        )
                      ) {
                        turboOptimistic = false;
                      }
                      // While set, accepted creation writes join the log
                      // between passes rather than at once: the commit
                      // below is then still in flight when the pass ends.
                      let deferAbsorbs = false;
                      const plan = await planStepsAndWaits({
                        suspension,
                        run,
                        writer,
                        onCommitted: (result) => {
                          if (deferAbsorbs) pendingAbsorbs.push(result);
                          else absorbWrite(result);
                        },
                        eventCount: () => slotSnapshot().eventCount,
                        encryptionKey: await encryptionKey.value,
                        compression,
                        creatorMessageId: metadata.messageId,
                        inlineSlots,
                        // The inline steps run right after this commit, so
                        // their first start rides the same batch.
                        startInlineSteps: mayInline,
                        requestId,
                      });
                      // Turbo: a suspension of only new inline steps starts
                      // their bodies while their `step_created` commits.
                      // Each body's `step_started` follows that commit, and
                      // its outcome follows the start. Anything with a
                      // background step, a wait or a step that failed to
                      // serialize commits first, as without turbo.
                      const optimisticCreation =
                        turboOptimistic &&
                        mayInline &&
                        plan.steps.length > 0 &&
                        plan.failedCount === 0 &&
                        plan.waitCount === 0 &&
                        plan.steps.every((step) => step.inline);
                      let created: Awaited<ReturnType<typeof plan.commit>>;
                      let newInline: Array<
                        Omit<CreatedStep, 'event'> & {
                          started?: StartedInBatch;
                        }
                      >;
                      let creationGate:
                        | Promise<Map<string, CreatedStep>>
                        | undefined;
                      // Run-ahead: the same shape of suspension writes its
                      // creations ahead instead, when the World takes them
                      // as one batch and the depth allows.
                      const speculativeCreation =
                        boundaryRunAhead !== undefined &&
                        mayInline &&
                        writer.supportsBatch &&
                        plan.steps.length > 0 &&
                        plan.failedCount === 0 &&
                        plan.waitCount === 0 &&
                        plan.steps.every((step) => step.inline) &&
                        withinRunAheadDepth();
                      if (speculativeCreation && boundaryRunAhead) {
                        const starts = writeCreationAhead(
                          plan.events,
                          boundaryRunAhead
                        );
                        created = {
                          createdSteps: [],
                          failedStepCorrelationIds: new Set(),
                          createdWaits: [],
                          serializationBlockerCount:
                            plan.serializationBlockerCount,
                          serializationBlockers: [],
                        };
                        newInline = plan.steps.map((step) => {
                          const started = starts.get(step.correlationId);
                          return started ? { ...step, started } : step;
                        });
                      } else if (optimisticCreation) {
                        deferAbsorbs = true;
                        const committing = plan.commit();
                        creationGate = committing.then((result) => {
                          if (result.createdSteps.length < plan.steps.length) {
                            // A batch item was refused after its body
                            // started. Redeliver; the next delivery loads the
                            // log and decides from it.
                            throw new WorkflowWorldError(
                              'A step_created of an inline step started ahead of its commit was not committed',
                              { status: 503 }
                            );
                          }
                          return new Map(
                            result.createdSteps.map((step) => [
                              step.correlationId,
                              step,
                            ])
                          );
                        });
                        creationGate.catch(() => {});
                        const inFlightCreation = creationGate.then(
                          () => {},
                          () => {}
                        );
                        creationsInFlight.add(inFlightCreation);
                        void inFlightCreation.then(() =>
                          creationsInFlight.delete(inFlightCreation)
                        );
                        created = {
                          createdSteps: [],
                          failedStepCorrelationIds: new Set(),
                          createdWaits: [],
                          serializationBlockerCount:
                            plan.serializationBlockerCount,
                          serializationBlockers: [],
                        };
                        newInline = plan.steps;
                      } else {
                        created = await plan.commit();
                        newInline = created.createdSteps.filter(
                          (step) => step.inline
                        );
                      }
                      if (created.failedStepCorrelationIds.size > 0) {
                        return { type: 'reload', retainSession: false };
                      }
                      const retain = getRetentionDecision({
                        suspension,
                        serializationBlockerCount:
                          created.serializationBlockerCount +
                          (hookResult?.serializationBlockerCount ?? 0),
                        invocationContinuation: true,
                      }).retain;

                      // Background steps: enqueue the ones created now, and
                      // re-enqueue the ones a crashed earlier delivery of
                      // this same message created but never got out.
                      const reenqueue = new Set(
                        stepsToReenqueue({
                          events: replayedEvents,
                          messageId: metadata.messageId,
                          deliveryCount: metadata.deliveryCount,
                        })
                      );
                      const toEnqueue: StepMessageSpec[] = [];
                      for (const step of created.createdSteps) {
                        if (step.inline) continue;
                        toEnqueue.push({
                          correlationId: step.correlationId,
                          stepName: step.stepName,
                          stepCreatedEventId: step.event.eventId,
                          input: step.input,
                        });
                      }
                      for (const step of logSteps) {
                        if (!reenqueue.has(step.correlationId)) continue;
                        toEnqueue.push({
                          correlationId: step.correlationId,
                          stepName: step.stepName,
                          stepCreatedEventId: step.createdEventId,
                          ...(step.inline
                            ? { stepAttempt: step.starts + 1 }
                            : {}),
                        });
                      }
                      // Hook-resume TTR: when no inline step will report it,
                      // the first dispatched step carries the boundaries to
                      // the invocation that runs it.
                      const willRunInline =
                        mayInline &&
                        (newInline.length > 0 || runnableInline.length > 0);
                      let dispatchedTiming: HookResumeTiming | undefined;
                      if (!willRunInline && toEnqueue.length > 0) {
                        dispatchedTiming =
                          resumeTimingForMessage(resumeTracking);
                        if (dispatchedTiming) resumeTracking = undefined;
                      }
                      await enqueueStepMessages(
                        run,
                        toEnqueue,
                        undefined,
                        dispatchedTiming
                      );

                      // Inline steps: the ones created inline now, plus inline
                      // steps an earlier invocation started and never
                      // finished (its retry runs them again).
                      const inlineToRun: InlineStepSpec[] = [];
                      if (mayInline) {
                        for (const step of newInline) {
                          const started = startedFromBatch(step.started);
                          const gate = creationGate;
                          inlineToRun.push({
                            correlationId: step.correlationId,
                            stepName: step.stepName,
                            input: step.input,
                            attempt: 1,
                            startReason: 'first',
                            ...(started ? { started } : {}),
                            ...(step.startRefusal
                              ? { startRefusal: step.startRefusal }
                              : {}),
                            ...(gate
                              ? {
                                  // The batch's start, or its refusal.
                                  startAfter: observed(
                                    gate.then((steps) => {
                                      const committed = steps.get(
                                        step.correlationId
                                      );
                                      if (committed?.startRefusal) {
                                        throw committed.startRefusal;
                                      }
                                      return startedFromBatch(
                                        committed?.started
                                      );
                                    })
                                  ),
                                }
                              : {}),
                          });
                        }
                        for (const step of runnableInline) {
                          const createdEvent = replayedEvents.find(
                            (event) => event.eventId === step.createdEventId
                          );
                          const loadedInput =
                            createdEvent?.eventType === 'step_created'
                              ? createdEvent.eventData.input
                              : undefined;
                          inlineToRun.push({
                            correlationId: step.correlationId,
                            stepName: step.stepName,
                            createdEventId: step.createdEventId,
                            // A World may leave step inputs out of replay
                            // loads; read it back only then.
                            ...(loadedInput !== undefined
                              ? { input: loadedInput }
                              : {}),
                            attempt: step.starts + 1,
                            startReason:
                              step.starts === 0 ? 'first' : 'redelivery',
                            ...(step.firstStartedAt
                              ? { firstStartedAt: step.firstStartedAt }
                              : {}),
                          });
                        }
                      }

                      if (inlineToRun.length > 0) {
                        const latencyTracking = computeStepLatencyTracking({
                          events: replayedEvents,
                          invocationStartedClean:
                            invocationStartedClean === true,
                          // Turbo's synthesized run has a local-clock
                          // `createdAt`; only the run id's time is trusted.
                          runCreatedAtMs:
                            runIdCreatedAt(runId) ??
                            (turbo ? undefined : +run.createdAt),
                          runStartedReceivedAtMs,
                          replayMs: replayDurationMs,
                          preStepBlockingMs,
                          preStepBlockingBeforeAttrMs: undefined,
                          suspensionHasWaits: suspension.waitCount > 0,
                          suspensionCreatedHooks: suspension.hookCount > 0,
                          turbo,
                          retained,
                        });
                        preStepBlockingMs += hookResult?.hookCreationMs ?? 0;
                        const ran = await runInlineSteps(
                          run,
                          inlineToRun,
                          latencyTracking,
                          boundaryRunAhead
                        );
                        return ran.type === 'continue'
                          ? { type: 'continue', retainSession: retain }
                          : ran;
                      }
                      if (inFlight.size > 0 || settledInline.length > 0) {
                        const progressed = await awaitInlineProgress(run);
                        return progressed.type === 'continue'
                          ? { type: 'continue', retainSession: retain }
                          : progressed;
                      }

                      // Suspend: nothing to run here. Arm the timers this
                      // delivery owns and acknowledge.
                      const wroteSomething =
                        created.createdSteps.length > 0 ||
                        created.createdWaits.length > 0 ||
                        (hookResult !== undefined && otherItems.length > 0);
                      // A delivery that ran ahead parks only on a confirmed
                      // log, so whatever landed below its speculative writes
                      // is acted on now.
                      if (speculationsBySlot.size > 0 || runAheadRepair) {
                        if ((await drainRunAhead()) === 'repair') {
                          await repairRunAhead();
                          return { type: 'continue', retainSession: false };
                        }
                        flushPending();
                      }
                      if (wroteSomething) await loadAfter();
                      assert(log, 'The event log is loaded on suspend');
                      // An event that landed after the VM decided (a hook
                      // payload, a background step's outcome) has a wake of
                      // its own, but that wake would find this position
                      // already recorded as consumed. Replay it now instead.
                      if (
                        log.events.some((event) => {
                          const slot = eventIdToSlot(event.eventId);
                          return (
                            slot !== null &&
                            slot > passConsumedSlot &&
                            !ownSlots.has(slot) &&
                            event.eventType !== 'noop'
                          );
                        })
                      ) {
                        return { type: 'continue', retainSession: false };
                      }
                      await armTimers(log.events);
                      recordConsumedPosition(world, runId, {
                        slot: maxEventSlot(log.events) ?? 0,
                        ...nextTimerAt(log.events),
                      });
                      return { type: 'return', result: undefined };
                    }

                    /**
                     * Starts inline steps as background work of this
                     * delivery, then waits for the next progress.
                     */
                    async function runInlineSteps(
                      run: WorkflowRun,
                      steps: InlineStepSpec[],
                      latencyTracking?: ReturnType<
                        typeof computeStepLatencyTracking
                      >,
                      /** Set when these steps' outcomes may run ahead. */
                      runAhead?: RunAheadContext
                    ): Promise<InlineProgress> {
                      assert(log, 'The event log is loaded for inline steps');
                      // Decided once per batch: the latch can end while
                      // these bodies run. A run-ahead boundary starts its
                      // bodies ahead of their start too.
                      const optimistic =
                        turboOptimistic || runAhead !== undefined;
                      if (!liveFeed) {
                        liveFeed = new LiveLogFeed(world, runId, {
                          afterSlot: maxEventSlot(log.events) ?? 0,
                          cursor: log.cursor,
                          pollIntervalMs: getOrchestratorPollIntervalMs(),
                          onEvents: (events) => {
                            pendingFeedEvents.push(...events);
                            notifyProgress();
                          },
                        });
                        liveFeed.start();
                      }
                      const tracking = resumeTracking;
                      resumeTracking = undefined;
                      const stepEncryptionKey = await encryptionKey.value;
                      let first = true;
                      for (const step of steps) {
                        if (ranInline.has(step.correlationId)) continue;
                        ranInline.add(step.correlationId);
                        const isFirst = first;
                        first = false;
                        const body = (async () => {
                          const input =
                            step.input ??
                            (await readStepInput(step.createdEventId));
                          return runStepSingleFlight(
                            runId,
                            step.correlationId,
                            () =>
                              executeStep({
                                world,
                                createEvent: async (data, params) => {
                                  if (
                                    runAhead &&
                                    (data.eventType === 'step_completed' ||
                                      data.eventType === 'step_failed')
                                  ) {
                                    if (
                                      withinRunAheadDepth([step.correlationId])
                                    ) {
                                      return writeOutcomeAhead(
                                        data,
                                        params,
                                        runAhead
                                      );
                                    }
                                    runAheadStats.depthCap++;
                                    recordRunAheadSpan();
                                  }
                                  const result = await writer.create(data, {
                                    ...params,
                                    ...slotSnapshot(),
                                    resolveData: REPLAY_RESOLVE_DATA,
                                  });
                                  pendingAbsorbs.push(result);
                                  return result;
                                },
                                workflowRunId: runId,
                                workflowDeploymentId: run.deploymentId,
                                workflowName,
                                workflowStartedAt,
                                rootRunId: rootRunIdFrom(run.attributes, runId),
                                requestId,
                                stepId: step.correlationId,
                                stepName: step.stepName,
                                encryptionKey: stepEncryptionKey,
                                runSpecVersion: run.specVersion,
                                attempt: step.attempt,
                                startReason: step.startReason,
                                ...(step.firstStartedAt
                                  ? { firstStartedAt: step.firstStartedAt }
                                  : {}),
                                input,
                                ...(step.started
                                  ? { started: step.started }
                                  : {}),
                                ...(step.startRefusal
                                  ? { startRefusal: step.startRefusal }
                                  : {}),
                                // Turbo: optimistic for a step's first
                                // attempt while turbo still allows it.
                                forceOptimisticStart:
                                  optimistic && step.startReason === 'first',
                                ...(runReadyBarrier ? { runReadyBarrier } : {}),
                                ...(step.startAfter
                                  ? { startAfter: step.startAfter }
                                  : {}),
                                beforeBody: () => writer.assertActive(),
                                ...(isFirst && tracking
                                  ? { resumeTracking: tracking }
                                  : {}),
                                ...(isFirst && latencyTracking
                                  ? { latencyTracking }
                                  : {}),
                              }),
                            'debug'
                          );
                        })();
                        const tracked = body.then(
                          (value) => {
                            settledInline.push({
                              spec: step,
                              outcome: { status: 'fulfilled', value },
                            });
                          },
                          (reason: unknown) => {
                            settledInline.push({
                              spec: step,
                              outcome: { status: 'rejected', reason },
                            });
                          }
                        );
                        inFlight.set(
                          step.correlationId,
                          tracked.finally(() => {
                            inFlight.delete(step.correlationId);
                            notifyProgress();
                          })
                        );
                      }
                      return awaitInlineProgress(run);
                    }

                    /**
                     * Waits for an inline body to settle, a live-feed event
                     * or the next due timer, then takes in what settled.
                     */
                    async function awaitInlineProgress(
                      run: WorkflowRun
                    ): Promise<InlineProgress> {
                      // The timer also goes out as a queue message, as on
                      // suspend: this delivery completes a due wait itself
                      // while it is alive, and the message covers the wait if
                      // the delivery ends first.
                      if (log) await armTimers(log.events);
                      replayBudget.pause();
                      try {
                        // Wake for a settled body, an event from someone
                        // else, or a due timer. Anything else (the feed's echo
                        // of this delivery's own writes) would only cost the
                        // workflow a pass with nothing new to act on.
                        while (true) {
                          await waitForProgress();
                          if (settledInline.length > 0) break;
                          if (runAheadFailure !== undefined) break;
                          if (pendingFeedEvents.some((e) => !isOwnEvent(e))) {
                            break;
                          }
                          if (
                            log &&
                            dueWaits(log.events, Date.now()).length > 0
                          ) {
                            break;
                          }
                          if (inFlight.size === 0) break;
                        }
                        // Turbo: no pass decides while a creation it would
                        // re-derive is still in flight. Its events join the
                        // log only once it committed, and a pass before that
                        // would create those steps again.
                        while (creationsInFlight.size > 0) {
                          await Promise.allSettled([...creationsInFlight]);
                        }
                      } finally {
                        replayBudget.resume();
                      }
                      flushPending();
                      if (runAheadFailure !== undefined) throw runAheadFailure;
                      const settled = settledInline.splice(0);
                      // Supersession wins over any other failure; the outer
                      // drain lets the remaining bodies settle.
                      const failures = settled.flatMap((item) =>
                        item.outcome.status === 'rejected'
                          ? [item.outcome.reason]
                          : []
                      );
                      if (failures.length > 0) {
                        throw (
                          failures.find((reason) =>
                            OrchestratorSupersededError.is(reason)
                          ) ?? failures[0]
                        );
                      }

                      let reload = false;
                      for (const item of settled) {
                        const step = item.spec;
                        const result = (
                          item.outcome as PromiseFulfilledResult<
                            Awaited<ReturnType<typeof executeStep>>
                          >
                        ).value;
                        if (result.type === 'gone') {
                          forgetConsumedPosition(world, runId);
                          return { type: 'return', result: undefined };
                        }
                        if (result.type === 'throttled') {
                          throttledSeconds = Math.max(
                            throttledSeconds ?? 0,
                            result.timeoutSeconds
                          );
                          continue;
                        }
                        if (result.type === 'retry') {
                          // The retry moves to the background: this is the
                          // step's first message, carrying the next attempt.
                          await enqueueStepMessages(
                            run,
                            [
                              {
                                correlationId: step.correlationId,
                                stepName: step.stepName,
                                stepAttempt: step.attempt + 1,
                                ...(step.createdEventId
                                  ? { stepCreatedEventId: step.createdEventId }
                                  : {}),
                                ...(step.input ? { input: step.input } : {}),
                              },
                            ],
                            result.timeoutSeconds
                          );
                          continue;
                        }
                        if (
                          result.type === 'completed' &&
                          result.hasPendingOps
                        ) {
                          pendingStreamOps = true;
                        }
                        assert(
                          log,
                          'The event log is loaded after inline steps'
                        );
                        if (runAheadRepair) {
                          // Not folded: the log is reloaded once the
                          // speculative writes settle.
                          reload = true;
                        } else if (
                          consumeOwnResolvingWrite(
                            log.events,
                            preparedResult(result.result)
                          ).type === 'reload'
                        ) {
                          reload = true;
                        }
                      }
                      if (throttledSeconds !== undefined) {
                        // Every sibling still running settles and is acted on
                        // first (a retry's message goes out now), then the
                        // run is deferred by the longest backoff.
                        if (inFlight.size > 0) return awaitInlineProgress(run);
                        return {
                          type: 'return',
                          result: { timeoutSeconds: throttledSeconds },
                        };
                      }
                      if (pendingStreamOps && inFlight.size === 0) {
                        // Stream writes are still flushing through
                        // `waitUntil`; hand the run to the next delivery so
                        // this one can end.
                        await wakeSelf();
                        return { type: 'return', result: undefined };
                      }
                      return reload
                        ? { type: 'reload-full' }
                        : { type: 'continue', retainSession: true };
                    }

                    /** Reads a step's input from its `step_created`. */
                    async function readStepInput(
                      createdEventId: string | undefined
                    ): Promise<SerializedData> {
                      if (createdEventId === undefined) {
                        throw new WorkflowRuntimeError(
                          'An inline step has neither an input nor a step_created event'
                        );
                      }
                      const created = await world.events.get(
                        runId,
                        createdEventId,
                        { resolveData: 'all' }
                      );
                      if (created.eventType !== 'step_created') {
                        throw new WorkflowRuntimeError(
                          `Event "${createdEventId}" is not a step_created`
                        );
                      }
                      return created.eventData.input;
                    }

                    /**
                     * Enqueues background step messages: one message per
                     * step, with a key stable for the step and a retention
                     * that covers its retries.
                     */
                    async function enqueueStepMessages(
                      run: WorkflowRun,
                      steps: StepMessageSpec[],
                      delaySeconds?: number,
                      hookResumeTiming?: HookResumeTiming
                    ): Promise<void> {
                      if (steps.length === 0) return;
                      const traceCarrier = await nextTraceCarrier();
                      const binaryTransport =
                        (run.specVersion ?? 0) >=
                        SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT;
                      await queueMessages(
                        world,
                        getWorkflowQueueName(workflowName, namespace),
                        steps.map((step, index) => {
                          const maxRetries =
                            getStepFunction(step.stepName)?.maxRetries ??
                            DEFAULT_STEP_MAX_RETRIES;
                          const carryInput =
                            binaryTransport &&
                            step.input instanceof Uint8Array &&
                            step.input.byteLength <=
                              MAX_STEP_MESSAGE_INPUT_BYTES;
                          return {
                            message: {
                              runId,
                              stepId: step.correlationId,
                              stepName: step.stepName,
                              traceCarrier,
                              requestedAt: new Date(),
                              runContext: runDispatchContext(run),
                              ...(step.stepCreatedEventId
                                ? {
                                    stepCreatedEventId: step.stepCreatedEventId,
                                  }
                                : {}),
                              ...(carryInput
                                ? {
                                    stepInput: {
                                      input: step.input as Uint8Array,
                                    },
                                  }
                                : {}),
                              ...(step.stepAttempt && step.stepAttempt > 1
                                ? { stepAttempt: step.stepAttempt }
                                : {}),
                              ...(index === 0 && hookResumeTiming
                                ? { hookResumeTiming }
                                : {}),
                            },
                            opts: {
                              idempotencyKey: stepDispatchIdempotencyKey(
                                step.correlationId,
                                step.stepName
                              ),
                              retentionSeconds:
                                stepMessageRetentionSeconds(maxRetries),
                              ...(delaySeconds !== undefined && delaySeconds > 0
                                ? { delaySeconds }
                                : {}),
                            },
                          };
                        })
                      );
                    }

                    /** Schedules the timers this delivery owns. */
                    async function armTimers(events: Event[]): Promise<void> {
                      const now = Date.now();
                      let earliest:
                        | { correlationId: string; resumeAtMs: number }
                        | undefined;
                      for (const wait of openWaits(events)) {
                        if (
                          !schedulesWaitTimer({
                            wait: wait.event,
                            correlationId: wait.correlationId,
                            messageId: metadata.messageId,
                            timerFor: waitContinuation?.correlationId,
                          })
                        ) {
                          continue;
                        }
                        if (
                          !earliest ||
                          wait.resumeAtMs < earliest.resumeAtMs
                        ) {
                          earliest = {
                            correlationId: wait.correlationId,
                            resumeAtMs: wait.resumeAtMs,
                          };
                        }
                      }
                      if (!earliest) return;
                      // One message per wait per delivery: a delivery that
                      // waits on inline bodies arms the timer early, and its
                      // suspend would otherwise send a second one.
                      const armKey = `${earliest.correlationId}@${earliest.resumeAtMs}`;
                      if (armedTimers.has(armKey)) return;
                      armedTimers.add(armKey);
                      const seconds = Math.max(
                        0,
                        Math.ceil((earliest.resumeAtMs - now) / 1000)
                      );
                      const { delaySeconds } = getWaitContinuationDispatch(
                        seconds,
                        earliest.correlationId,
                        now
                      );
                      await wakeSelf(
                        {
                          waitContinuation: {
                            correlationId: earliest.correlationId,
                            attempt: 0,
                          },
                        },
                        delaySeconds
                      );
                    }

                    /**
                     * Records a replay divergence and queues a recovery
                     * replay while the budget lasts.
                     */
                    async function maybeRecoverDivergence(
                      err: ReplayDivergenceError
                    ): Promise<
                      | { type: 'queued' }
                      | {
                          type: 'fail';
                          error: Error;
                          divergenceCount: number;
                          logFields: Record<string, unknown>;
                        }
                    > {
                      const divergenceCount =
                        (replayDivergence?.count ?? 0) + 1;
                      const maxRecoveryReplays =
                        getReplayDivergenceMaxRetries();
                      const divergenceEventIds = [
                        ...(replayDivergence?.eventIds ??
                          (replayDivergence ? [replayDivergence.eventId] : [])),
                        err.eventId,
                      ].slice(-(maxRecoveryReplays + 1));
                      const logFields = {
                        errorCode: RUN_ERROR_CODES.REPLAY_DIVERGENCE,
                        divergenceEventId: err.eventId,
                        priorDivergenceEventId: replayDivergence?.eventId,
                        divergenceEventIds,
                        divergenceCount,
                        maxRecoveryReplays,
                        loopIteration,
                        deliveryAttempt: metadata.attempt,
                        eventLogLength: log?.events.length,
                        eventLogLastEventId: log?.events.at(-1)?.eventId,
                        isRecoveryReplay: replayDivergence !== undefined,
                        hasHookInput: hookInput !== undefined,
                        hasWaitContinuation: waitContinuation !== undefined,
                      };
                      if (divergenceCount <= maxRecoveryReplays) {
                        runLogger.warn(
                          'Workflow replay diverged; queueing a recovery replay before declaring the event log corrupted',
                          {
                            errorCode: RUN_ERROR_CODES.REPLAY_DIVERGENCE,
                            divergenceEventId: err.eventId,
                            divergenceEventIds,
                            divergenceCount,
                            maxRecoveryReplays,
                            loopIteration,
                            deliveryAttempt: metadata.attempt,
                            eventLogLength: log?.events.length,
                            eventLogLastEventId: log?.events.at(-1)?.eventId,
                            isRecoveryReplay: replayDivergence !== undefined,
                            hasHookInput: hookInput !== undefined,
                            hasWaitContinuation: waitContinuation !== undefined,
                            errorMessage: err.message,
                          }
                        );
                        await wakeSelf({
                          replayDivergence: {
                            eventId: err.eventId,
                            count: divergenceCount,
                            eventIds: divergenceEventIds,
                          },
                        });
                        return { type: 'queued' };
                      }
                      return {
                        type: 'fail',
                        divergenceCount,
                        logFields,
                        error: new CorruptedEventLogError(
                          `Workflow replay diverged ${divergenceCount} times after ${maxRecoveryReplays} recovery replays; latest divergent event was ${err.eventId}; divergent event ids: ${divergenceEventIds.join(', ')}. Last divergence: ${err.message}`,
                          { cause: err }
                        ),
                      };
                    }
                  }

                  /** Records `run_failed` for an error the run cannot survive. */
                  async function failRun(
                    terminalError: unknown,
                    effectiveWorkflowCode: string,
                    replayDivergenceCount?: number,
                    extraLogFields: Record<string, unknown> = {}
                  ): Promise<undefined> {
                    if (terminalError instanceof Error) {
                      span?.recordException?.(terminalError);
                    }
                    const normalizedError =
                      await normalizeUnknownError(terminalError);
                    const errorName =
                      normalizedError.name || getErrorName(terminalError);
                    const errorMessage = normalizedError.message;
                    let errorStack =
                      normalizedError.stack || getErrorStack(terminalError);
                    if (errorStack) {
                      const parsedName = parseWorkflowName(workflowName);
                      const filename =
                        parsedName?.moduleSpecifier || workflowName;
                      errorStack = remapErrorStack(
                        errorStack,
                        filename,
                        effectiveWorkflowCode
                      );
                    }
                    const errorCode = classifyRunError(terminalError);
                    runtimeLogger.error('Error while running workflow', {
                      ...extraLogFields,
                      workflowRunId: runId,
                      errorCode,
                      errorName,
                      errorMessage,
                      errorStack,
                      errorCause:
                        formatErrorCauseChain(terminalError) || undefined,
                    });
                    if (types.isNativeError(terminalError) && errorStack) {
                      setErrorStack(terminalError, errorStack);
                    }
                    let failureKey: PayloadKey | undefined;
                    let dehydratedError: Uint8Array;
                    let failedResult: EventResult | undefined;
                    try {
                      failureKey = await encryptionKey.value;
                      dehydratedError = await dehydrateRunError(
                        terminalError,
                        runId,
                        failureKey,
                        globalThis,
                        (workflowRun?.specVersion ?? 0) >=
                          SPEC_VERSION_SUPPORTS_COMPRESSION
                      );
                      failedResult = await createEvent(
                        {
                          eventType: 'run_failed',
                          specVersion: SPEC_VERSION_CURRENT,
                          eventData: { error: dehydratedError, errorCode },
                        },
                        {
                          requestId,
                          ...(replayDivergenceCount !== undefined
                            ? { replayDivergenceCount }
                            : {}),
                        }
                      );
                    } catch (failErr) {
                      if (
                        EntityConflictError.is(failErr) ||
                        RunExpiredError.is(failErr)
                      ) {
                        runtimeLogger.info(
                          'Tried failing workflow run, but run has already finished.',
                          {
                            workflowRunId: runId,
                            message:
                              failErr instanceof Error
                                ? failErr.message
                                : String(failErr),
                          }
                        );
                        return undefined;
                      }
                      if (isWorldContractError(failErr)) {
                        runtimeLogger.error(
                          'Fatal world contract error while recording workflow failure',
                          {
                            workflowRunId: runId,
                            errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
                            error:
                              failErr instanceof Error
                                ? failErr.message
                                : String(failErr),
                          }
                        );
                        return undefined;
                      }
                      throw failErr;
                    }
                    forgetConsumedPosition(world, runId);
                    // As for completion: an out-of-band terminal event at a
                    // lower position decided the run instead.
                    const recordedStatus = failedResult?.run?.status;
                    if (
                      recordedStatus !== undefined &&
                      recordedStatus !== 'failed'
                    ) {
                      return undefined;
                    }
                    dispatchRunFailedHooks(
                      runId,
                      workflowName,
                      dehydratedError,
                      failureKey,
                      errorCode
                    );
                    span?.setAttributes({
                      ...Attribute.WorkflowRunStatus('failed'),
                      ...Attribute.WorkflowErrorCode(errorCode),
                      ...Attribute.WorkflowErrorName(errorName),
                      ...Attribute.WorkflowErrorMessage(errorMessage),
                      ...Attribute.ErrorType(errorName),
                    });
                    return undefined;
                  }
                }
              );
            }
          );
        });
      })
    );

  let cachedHandler: ((req: Request) => Promise<Response>) | undefined;
  let invocationCount = 0;
  const entrypointCreatedAt = Date.now();
  const routeModuleBodyInitMs =
    typeof options?.routeModuleBodyStartedAt === 'number'
      ? entrypointCreatedAt - options.routeModuleBodyStartedAt
      : undefined;

  return withHealthCheck(async (req) => {
    invocationCount += 1;
    const handlerCached = cachedHandler !== undefined;
    const spanKind = await getSpanKind('SERVER');

    return trace(
      'workflow.route.flow',
      {
        kind: spanKind,
        attributes: {
          ...Attribute.WorkflowRouteType('flow'),
          ...Attribute.FaasInstance(COMPUTE_INSTANCE_ID),
          ...Attribute.WorkflowRouteHandlerCached(handlerCached),
          ...Attribute.WorkflowRouteInvocationCount(invocationCount),
          ...Attribute.WorkflowRouteEntrypointAgeMs(
            Date.now() - entrypointCreatedAt
          ),
          ...(routeModuleBodyInitMs === undefined
            ? {}
            : Attribute.WorkflowRouteModuleBodyInitMs(routeModuleBodyInitMs)),
          ...Attribute.HttpRequestMethod(req.method),
          ...Attribute.HttpRoute('/.well-known/workflow/v1/flow'),
        },
      },
      async (span) => {
        if (!cachedHandler) {
          cachedHandler = await trace('workflow.route.init', async () => {
            // The full runtime World, not `getWorldHandlers()`. That accessor
            // owns a second, build-time-safe cache, so calling it here built a
            // second World in the same process: duplicate connection pools and
            // queue workers for a stateful World, plus a second copy of that
            // world package's modules once it is bundled, which is what
            // silently demoted the events WebSocket transport to HTTP. #3665.
            //
            // The span keeps its original name. It is a distinct span from the
            // per-request `workflow.route.get_world` at the top of the flow
            // route, and renaming it would collide with that one.
            const worldHandlers = await trace(
              'workflow.route.get_world_handlers',
              async () => getWorld()
            );
            return handler(worldHandlers);
          });
        }

        const response = await cachedHandler(req);
        if (response instanceof Response) {
          span?.setAttributes(
            Attribute.HttpResponseStatusCode(response.status)
          );
        }
        return response;
      }
    );
  });
}
