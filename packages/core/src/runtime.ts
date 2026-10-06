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
  eventIdToSlot,
  getQueueTopicPrefix,
  type HookResumeTiming,
  isSealedNoopEvent,
  isTerminalWorkflowRunStatus,
  type RunInput,
  resolveQueueNamespace,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
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
  getReplayDivergenceMaxRetries,
  isDynamicWorkflowsEnabled,
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
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
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
import { stepMessageRetentionSeconds } from './runtime/orchestrator/step-retention.js';
import { createStepsAndWaits } from './runtime/orchestrator/step-wait-creation.js';
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
        } = WorkflowInvokePayloadSchema.parse(message_);

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
            await world.events.create(
              runId,
              {
                eventType: 'run_failed',
                specVersion: SPEC_VERSION_CURRENT,
                eventData: {
                  error: dehydratedError,
                  errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
                },
              },
              // Before any log load, so there is no fence count to carry.
              { requestId, inBand: false }
            );
          } catch (err) {
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
                    log ? slotSnapshotParams(log.events) : {};
                  // Set when an accepted write could not be folded into the
                  // log without leaving a hole; the next pass reads first.
                  let logBehind = false;
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
                    if (!log || !result.event) return;
                    if (result.reportIncomplete || result.hasMore) {
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
                    mergeReportedEvents(log.events, [...report, own]);
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
                    writer.adoptSnapshot(loaded.snapshot);
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
                    beforeStop?: () => Promise<void>
                  ): Promise<DeploymentAffinityOutcome> => {
                    const { outcome, spanAttributes } =
                      await guardDeploymentAffinity({
                        world,
                        run,
                        workflowName,
                        requestId,
                        retryCount: deploymentMismatchRetryCount,
                        beforeStop,
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
                  if (
                    !runInput &&
                    !hookInput &&
                    !replayDivergence &&
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
                  } catch (err) {
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
                    throw err;
                  }

                  async function orchestrate(): Promise<
                    { timeoutSeconds: number } | undefined
                  > {
                    // --- Run setup: full load (with the fence snapshot) ---
                    const [loadOutcome, runOutcome] = await Promise.allSettled([
                      fullLoad(),
                      world.runs.get(runId, { resolveData: 'none' }),
                    ]);
                    let run: WorkflowRun | undefined =
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
                      // the run from `run_started`.
                      log = { events: [], cursor: null };
                    } else if (loadOutcome.status === 'rejected') {
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
                      (await guardDeployment(run, async () => ({
                        ...(await replayMessage()),
                        ...(hookInput ? { hookInput } : {}),
                        ...(hookResumeTiming ? { hookResumeTiming } : {}),
                      }))) !== 'continue'
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
                        const started = await createEvent(
                          {
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
                                    dynamicWorkflowCode:
                                      runInput.dynamicWorkflowCode,
                                    dynamicWorkflowCodeRef:
                                      runInput.dynamicWorkflowCodeRef,
                                  },
                                }
                              : {}),
                          },
                          { requestId }
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
                    const runInputValue = runCreated
                      ? runCreated.eventData.input
                      : (await world.runs.get(runId, { resolveData: 'all' }))
                          .input;
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
                          isRetryableWorldError(err)
                        ) {
                          throw err;
                        }
                        return await failRun(err, effectiveWorkflowCode);
                      }
                    }

                    let session: WorkflowSession | null = null;
                    const continuedHookIds = new Set<string>();
                    const inlineDeadlineMs =
                      invocationStartTime + noInlineReplayAfterMs;
                    const inlineMarginMs = getInlineStepDeadlineMarginMs();

                    // Main loop: replay, decide, write, run inline steps.
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
                        if (logBehind) await loadAfter();
                        assert(log, 'The event log is loaded in the loop');
                        if (hasRecordedTerminalRunEvent(log.events, runId)) {
                          forgetConsumedPosition(world, runId);
                          return undefined;
                        }

                        // Complete elapsed waits. `wait_completed` resolves a
                        // promise, so it is consumed only after it commits,
                        // behind whatever its report says landed below it.
                        for (const wait of dueWaits(log.events, Date.now())) {
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
                            consumeOwnResolvingWrite(log.events, completed)
                              .type === 'reload'
                          ) {
                            session = null;
                            await fullLoad();
                          }
                        }
                        assert(log, 'The event log is loaded in the loop');

                        if (isSlotGapCheckEnabled()) {
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
                        let workflowResult: WorkflowResumeResult = session
                          ? await resumeWorkflow(session, log.events)
                          : { type: 'replay' };
                        const servedByRetained =
                          session !== null && workflowResult.type !== 'replay';
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
                          try {
                            await createEvent(
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
                          resumeTracking.nextStepEncounteredAtMs ??= Date.now();
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
                          await fullLoad();
                        } else if (outcome.type === 'reload') {
                          if (!outcome.retainSession) session = null;
                          await loadAfter();
                        } else if (!outcome.retainSession) {
                          session = null;
                        }
                      } catch (err) {
                        if (
                          OrchestratorSupersededError.is(err) ||
                          writer.isSuperseded
                        ) {
                          throw err;
                        }
                        if (isRetryableWorldError(err)) {
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
                        (step) => step.runnableInline
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
                            getMaxInlineSteps() - runnableInline.length
                          )
                        : 0;
                      const created = await createStepsAndWaits({
                        suspension,
                        run,
                        writer,
                        onCommitted: absorbWrite,
                        eventCount: () => slotSnapshot().eventCount,
                        encryptionKey: await encryptionKey.value,
                        compression,
                        creatorMessageId: metadata.messageId,
                        inlineSlots,
                        requestId,
                      });
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
                        (created.createdSteps.some((step) => step.inline) ||
                          runnableInline.length > 0);
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
                        for (const step of created.createdSteps) {
                          if (!step.inline) continue;
                          inlineToRun.push({
                            correlationId: step.correlationId,
                            stepName: step.stepName,
                            input: step.input,
                            attempt: 1,
                            startReason: 'first',
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
                          });
                        }
                      }

                      if (inlineToRun.length > 0) {
                        const latencyTracking = computeStepLatencyTracking({
                          events: replayedEvents,
                          invocationStartedClean:
                            invocationStartedClean === true,
                          runCreatedAtMs:
                            runIdCreatedAt(runId) ?? +run.createdAt,
                          runStartedReceivedAtMs,
                          replayMs: replayDurationMs,
                          preStepBlockingMs,
                          preStepBlockingBeforeAttrMs: undefined,
                          suspensionHasWaits: suspension.waitCount > 0,
                          suspensionCreatedHooks: suspension.hookCount > 0,
                          turbo: false,
                          retained,
                        });
                        preStepBlockingMs += hookResult?.hookCreationMs ?? 0;
                        const ran = await runInlineSteps(
                          run,
                          inlineToRun,
                          latencyTracking
                        );
                        return ran.type === 'continue'
                          ? { type: 'continue', retainSession: retain }
                          : ran;
                      }

                      // Suspend: nothing to run here. Arm the timers this
                      // delivery owns and acknowledge.
                      const wroteSomething =
                        created.createdSteps.length > 0 ||
                        created.createdWaits.length > 0 ||
                        (hookResult !== undefined && otherItems.length > 0);
                      if (wroteSomething) await loadAfter();
                      assert(log, 'The event log is loaded on suspend');
                      await armTimers(log.events);
                      recordConsumedPosition(world, runId, {
                        slot: maxEventSlot(log.events) ?? 0,
                        ...nextTimerAt(log.events),
                      });
                      return { type: 'return', result: undefined };
                    }

                    /** Runs a batch of inline steps in this process. */
                    async function runInlineSteps(
                      run: WorkflowRun,
                      steps: InlineStepSpec[],
                      latencyTracking?: ReturnType<
                        typeof computeStepLatencyTracking
                      >
                    ): Promise<
                      | {
                          type: 'return';
                          result: { timeoutSeconds: number } | undefined;
                        }
                      | { type: 'reload-full' }
                      | { type: 'continue'; retainSession: boolean }
                    > {
                      assert(log, 'The event log is loaded for inline steps');
                      const feed = new LiveLogFeed(world, runId, {
                        afterSlot: maxEventSlot(log.events) ?? 0,
                        cursor: log.cursor,
                        pollIntervalMs: getOrchestratorPollIntervalMs(),
                        onEvents: (events) => {
                          if (log) mergeReportedEvents(log.events, events);
                        },
                      });
                      feed.start();
                      const tracking = resumeTracking;
                      resumeTracking = undefined;
                      replayBudget.pause();
                      let results: Awaited<ReturnType<typeof executeStep>>[];
                      const stepEncryptionKey = await encryptionKey.value;
                      try {
                        const settled = await Promise.allSettled(
                          steps.map(async (step, index) => {
                            const input =
                              step.input ??
                              (await readStepInput(step.createdEventId));
                            return runStepSingleFlight(
                              runId,
                              step.correlationId,
                              () =>
                                executeStep({
                                  world,
                                  createEvent: (data, params) =>
                                    writeInBand(data, {
                                      ...params,
                                      ...slotSnapshot(),
                                      resolveData: REPLAY_RESOLVE_DATA,
                                    }),
                                  workflowRunId: runId,
                                  workflowDeploymentId: run.deploymentId,
                                  workflowName,
                                  workflowStartedAt,
                                  rootRunId: rootRunIdFrom(
                                    run.attributes,
                                    runId
                                  ),
                                  requestId,
                                  stepId: step.correlationId,
                                  stepName: step.stepName,
                                  encryptionKey: stepEncryptionKey,
                                  runSpecVersion: run.specVersion,
                                  attempt: step.attempt,
                                  startReason: step.startReason,
                                  input,
                                  beforeBody: () => writer.assertActive(),
                                  ...(index === 0 && tracking
                                    ? { resumeTracking: tracking }
                                    : {}),
                                  ...(index === 0 && latencyTracking
                                    ? { latencyTracking }
                                    : {}),
                                }),
                              'debug'
                            );
                          })
                        );
                        // Every body has settled before anything else
                        // happens, so a superseded delivery leaves nothing
                        // running behind it. Supersession wins over any other
                        // failure.
                        const failures = settled.flatMap((outcome) =>
                          outcome.status === 'rejected' ? [outcome.reason] : []
                        );
                        if (failures.length > 0) {
                          throw (
                            failures.find((reason) =>
                              OrchestratorSupersededError.is(reason)
                            ) ?? failures[0]
                          );
                        }
                        results = settled.map(
                          (outcome) =>
                            (
                              outcome as PromiseFulfilledResult<
                                Awaited<ReturnType<typeof executeStep>>
                              >
                            ).value
                        );
                      } finally {
                        replayBudget.resume();
                        feed.stop();
                      }

                      let reload = false;
                      let pendingOps = false;
                      for (const [index, result] of results.entries()) {
                        const step = steps[index];
                        assert(step, 'Each inline result has its step');
                        if (result.type === 'gone') {
                          forgetConsumedPosition(world, runId);
                          return { type: 'return', result: undefined };
                        }
                        if (result.type === 'throttled') {
                          return {
                            type: 'return',
                            result: { timeoutSeconds: result.timeoutSeconds },
                          };
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
                          pendingOps = true;
                        }
                        assert(
                          log,
                          'The event log is loaded after inline steps'
                        );
                        if (
                          consumeOwnResolvingWrite(log.events, result.result)
                            .type === 'reload'
                        ) {
                          reload = true;
                        }
                      }
                      if (pendingOps) {
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
                      await createEvent(
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
