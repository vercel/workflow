import assert from 'node:assert/strict';
import { types } from 'node:util';
import {
  CorruptedEventLogError,
  EntityConflictError,
  FatalError,
  HookNotFoundError,
  MaxEventsExceededError,
  PreconditionFailedError,
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
  getQueueTopicPrefix,
  isLegacySpecVersion,
  isTerminalRunEventType,
  ROOT_RUN_ID_ATTRIBUTE,
  type RunInput,
  resolveQueueNamespace,
  SPEC_VERSION_CURRENT,
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
import { type StepInvocationQueueItem, WorkflowSuspension } from './global.js';
import { type Logger, runtimeLogger } from './logger.js';
import { getStepFunction } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { COMPUTE_INSTANCE_ID } from './runtime/compute-instance.js';
import {
  getMaxEventsOverride,
  getMaxQueueDeliveries,
  getPreconditionMaxInProcessRestarts,
  getPreconditionMaxReinvocations,
  getPreconditionReinvokeDelaySeconds,
  getReplayDivergenceMaxRetries,
  isInlineOwnershipEnabled,
  isTurboEnabled,
  isVmRetentionEnabled,
} from './runtime/constants.js';
import { countStepStartedEvents } from './runtime/count-step-started-events.js';
import {
  type DeploymentAffinityOutcome,
  guardDeploymentAffinity,
  type ReenqueueArgs,
} from './runtime/deployment-guard.js';
import {
  absorbSkippedSlotReport,
  appendUniqueEvents,
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  insertEventByEventId,
  isSlotGapCheckEnabled,
  type LoadedEventLog,
  loadWorkflowRunEvents,
  memoizeEncryptionKey,
  parseHealthCheckPayload,
  preconditionEventDelta,
  queueMessage,
  type SlotSnapshotParams,
  settleEventSlotGap,
  slotSnapshotParams,
  stepDispatchIdempotencyKey,
  withHealthCheck,
} from './runtime/helpers.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
} from './runtime/lifecycle-hooks.js';
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
  type PreclaimedInlineStart,
} from './runtime/step-executor.js';
import { computeStepLatencyTracking } from './runtime/step-latency.js';
import {
  backstopIdempotencyKey,
  hasPendingStepOwnedByMessage,
  isStepOwnershipActive,
  stepLeaseRemainingSeconds,
} from './runtime/step-ownership.js';
import { runStepSingleFlight } from './runtime/step-single-flight.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import { useQuickJSVm } from './runtime/vm-mode.js';
import { getWaitContinuationDispatch } from './runtime/wait-continuation.js';
import {
  getWorld,
  getWorldHandlers,
  type WorldHandlers,
} from './runtime/world.js';
import { dehydrateRunError } from './serialization.js';
import { remapErrorStack } from './source-map.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import {
  buildInvocationSpanLinks,
  getNextTraceCarrier,
  getSpanKind,
  getWorkflowTraceMode,
  isUsableTraceCarrier,
  trace,
  withTraceContext,
  withWorkflowBaggage,
} from './telemetry.js';
import { getErrorName, getErrorStack, normalizeUnknownError } from './types.js';
import { buildWorkflowSuspensionMessage } from './util.js';
import {
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
  type ResumedHook,
  resumeHook,
  resumeWebhook,
} from './runtime/resume-hook.js';
export {
  getRun,
  Run,
  type WorkflowReadableStream,
  type WorkflowReadableStreamOptions,
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
 * misconfigured caller can split them — writing the run to one environment
 * while addressing the message to a deployment in another. The consumer then
 * finds no run under its own tenant and the backend's resilient start
 * (`run_started` creates the run when `run_created` was never seen) mints a
 * SECOND copy of the same run id in this environment. Both copies are real: the
 * creator's sits pending forever, this one executes, and every subsequent
 * cross-tenant queue ack fails to find its message.
 *
 * Nothing external is needed to catch this: the creator's environment rides the
 * message in `runInput.environment` and this process already knows its own. So
 * compare them and stop BEFORE `run_started` — the write that would create the
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
 * A first-delivery message carries `runInput.deploymentId` — the deployment
 * `start()` addressed it to — so comparing that against this handler's own
 * deployment detects mis-delivery directly. This is a DIAGNOSTIC, not a gate:
 * it warns and lets the invocation proceed, deliberately.
 *
 * Why this one only warns while its environment sibling above refuses: a
 * differing deployment id is not by itself evidence of the fork we care about.
 * The environment pair is exact — two named environments that disagree — and it
 * is the dimension the run's tenant is keyed on. Deployment ids disagree for
 * benign reasons too: `world-local` derives its id from the installed package
 * version (`dpl_local@<version>`), so upgrading the SDK mid-run changes it with
 * nothing wrong. Refusing on that signal would strand correct runs, and
 * refusing before `run_started` leaves no server-side record to explain why.
 * Anyone tempted to promote this to a hard failure has to handle that first.
 *
 * Skipped unless BOTH ids are known — `getDeploymentId()` throws in worlds that
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
    // not a mismatch — there is simply nothing to compare against.
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

/**
 * Whether a step execution rejected because the step entity does not exist —
 * the signature of a resilient step dispatch message whose delivery beat (or
 * outlived a transient failure of) the producer's parallel `step_created`
 * write. Every World surfaces it as a `WorkflowWorldError` naming the missing
 * step: world-vercel maps the backend's 404 to
 * `workflow step step_… not found`, world-local and world-postgres throw
 * `Step "step_…" not found` directly. The message match is deliberately loose
 * across those shapes; the status check narrows the remote case without
 * excluding the local ones (which carry no status).
 *
 * Used only when the message carries `stepInput` — a bare dispatch without a
 * payload has nothing to recover from, and the error keeps propagating for
 * queue-driven recovery exactly as before.
 */
function isStepMissingError(err: unknown): boolean {
  if (!WorkflowWorldError.is(err)) return false;
  if (err.status !== undefined && err.status !== 404) return false;
  return /step/i.test(err.message) && /not found/i.test(err.message);
}

async function recordFatalRunError({
  world,
  workflowRun,
  runId,
  requestId,
  err,
  errorCode,
  logMessage,
}: {
  world: World;
  workflowRun: WorkflowRun | undefined;
  runId: string;
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

  try {
    const getEncryptionKey = memoizeEncryptionKey(world, workflowRun ?? runId);
    await world.events.create(
      runId,
      {
        eventType: 'run_failed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          error: await dehydrateRunError(
            err,
            runId,
            await getEncryptionKey(),
            globalThis,
            (workflowRun?.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION
          ),
          errorCode,
        },
      },
      { requestId }
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
  dispatchRunFailedHooks(runId, err, errorCode);
}

function hasRecordedTerminalRunEvent(events: Event[], runId: string): boolean {
  // Terminal run events are always last by construction (no event creation
  // succeeds against a terminal run), but scan the full array for
  // defense-in-depth: a World/backend ordering bug shouldn't make us miss an
  // actual termination signal.
  const terminalRunEvent = events.find(
    (e) =>
      e.runId === runId &&
      (e.eventType === 'run_completed' ||
        e.eventType === 'run_failed' ||
        e.eventType === 'run_cancelled')
  );

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

/** How many of `ids` are absent from `present`. */
function countMissingIds(ids: Iterable<string>, present: Set<string>): number {
  let missing = 0;
  for (const id of ids) {
    if (!present.has(id)) missing++;
  }
  return missing;
}

/**
 * The lineage root of a loaded run: its `$rootRunId` attribute, or its own id
 * when it is itself a root.
 */
function rootRunIdFrom(
  attributes: Record<string, string> | undefined,
  runId: string
): string {
  return attributes?.[ROOT_RUN_ID_ATTRIBUTE] ?? runId;
}

/**
 * Whether the run has a hook and/or wait that an out-of-band writer could
 * append an event for between an inline step's `step_completed` write and
 * the next replay — namely an open hook (a `hook_created` not yet
 * `hook_disposed`, which a webhook receiver can resolve with
 * `hook_received`) or an open wait (a `wait_created` not yet
 * `wait_completed`, which the wait timer can resolve with
 * `wait_completed`).
 *
 * This gates VM retention, the inline-delta fast path, and turbo's forced
 * optimistic start. A terminal-step delta can omit an event appended
 * concurrently after that write. With no open hook or wait, only cancellation
 * can do so, and observing it one replay late is safe because the next entity
 * write is rejected.
 *
 * Step-body `attr_set` writes are NOT a concern: they land before the
 * step's terminal write and are therefore already inside the returned
 * delta.
 */
function openHookAndWaitState(events: Event[]): {
  openHook: boolean;
  openWait: boolean;
} {
  const hooks = new Set<string>();
  const waits = new Set<string>();
  for (const event of events) {
    switch (event.eventType) {
      case 'hook_created':
        hooks.add(event.correlationId);
        break;
      case 'hook_disposed':
        hooks.delete(event.correlationId);
        break;
      case 'wait_created':
        waits.add(event.correlationId);
        break;
      case 'wait_completed':
        waits.delete(event.correlationId);
        break;
    }
  }
  return { openHook: hooks.size > 0, openWait: waits.size > 0 };
}

type ReplayEventLog =
  | { type: 'loadAll' }
  | ({ type: 'ready' } & LoadedEventLog)
  | ({ type: 'loadAfter'; cursor: string } & LoadedEventLog);

function nextEventLogLoad(log: LoadedEventLog): ReplayEventLog {
  if (log.cursor === null) {
    return { type: 'loadAll' };
  }
  return {
    type: 'loadAfter',
    events: log.events,
    cursor: log.cursor,
  };
}

function appendEventLog(log: LoadedEventLog, appended: LoadedEventLog): void {
  appendUniqueEvents(log.events, appended.events);
  log.cursor = appended.cursor ?? log.cursor;
}

/**
 * The whole retention predicate: keep the session only for a pure step
 * boundary (every suspension item is a step — any other item type, present
 * or future, is unretainable by default) whose new step inputs serialized
 * without executing workflow code, with no out-of-band continuation source:
 * attributes require replay; hooks and waits can wake another invocation.
 * `WORKFLOW_RETAINED_VM=0` disables retention entirely.
 *
 * The open hook/wait scan is O(events), so it is taken through a lazy getter
 * and consulted last, after every cheap check has passed.
 *
 * INVARIANT this predicate leans on: every suspension signaler that does NOT
 * carry the step-consumer generation guard (sleep, hook, attribute — see
 * `suspensionGeneration` in private.ts) must be unretainable here, either via
 * a non-step queue item or the open hook/wait scan. A new signaler that
 * satisfies neither would let a stale signal be accepted as a fresh
 * suspension on a resumed session.
 *
 * Quiescence assumes workflow code stays inside the sandbox's determinism
 * contract. Escaping to the host realm (e.g. recovering the host `Function`
 * constructor from an exposed host class to schedule real timers) makes a
 * workflow nondeterministic under ordinary replay too, and is not defended
 * here.
 */
function canRetainWorkflowSession(
  suspension: WorkflowSuspension,
  stepInputsSafe: boolean,
  openHookWait: { value: ReturnType<typeof openHookAndWaitState> }
): boolean {
  if (
    !isVmRetentionEnabled() ||
    !stepInputsSafe ||
    suspension.steps.length === 0 ||
    !suspension.steps.every((item) => item.type === 'step')
  ) {
    return false;
  }
  const { openHook, openWait } = openHookWait.value;
  return !openHook && !openWait;
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

  const handler = (worldHandlers: WorldHandlers) =>
    worldHandlers.createQueueHandler(
      workflowPrefix,
      async (message_, metadata) => {
        // T2 of the hook-resume TTR window (see runtime/resume-latency.ts):
        // the instant this consumer began, before message parsing. Only used
        // when the message turns out to carry resume timing; taking it
        // unconditionally keeps it honest for the deliveries that do.
        const handlerEnteredAtMs = Date.now();
        // Check if this is a health check message
        // NOTE: Health check messages are intentionally unauthenticated for monitoring purposes.
        // They only write a simple status response to a stream and do not expose sensitive data.
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
          preconditionReinvocations,
          deploymentMismatchRetryCount,
          runInput,
          hookInput,
          stepInput,
          hookResumeTiming,
        } = WorkflowInvokePayloadSchema.parse(message_);

        // --- Hook-resume TTR telemetry (runtime/resume-latency.ts) ---
        // Threaded through this invocation and CONSUMED by the first durable
        // step that follows the resumption — cleared at that point so a later
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
        // or no span is active — treat an empty carrier the same as an
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
        // Scoped logger for this run — attaches runId/workflowName to every
        // log line and child loggers below, so callers don't repeat it.
        const runLogger = runtimeLogger.forRun(runId, workflowName);

        const maxQueueDeliveries = getMaxQueueDeliveries();
        if (metadata.attempt > maxQueueDeliveries) {
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
          try {
            const world = await getWorld();
            const getEncryptionKey = memoizeEncryptionKey(world, runId);
            const err = new FatalError(
              `Workflow exceeded maximum queue deliveries (${metadata.attempt}/${maxQueueDeliveries})`
            );
            await world.events.create(
              runId,
              {
                eventType: 'run_failed',
                specVersion: SPEC_VERSION_CURRENT,
                eventData: {
                  error: await dehydrateRunError(
                    err,
                    runId,
                    await getEncryptionKey()
                  ),
                  errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
                },
              },
              { requestId }
            );
            dispatchRunFailedHooks(
              runId,
              err,
              RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED
            );
          } catch (err) {
            if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
              // Run already finished, consume the message silently
              return;
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
          }
          return;
        }

        // --- Trace correlation mode ---
        // 'linked' (default): the workflow.execute span below stays a CHILD
        // of the local delivery (flow-route) context, so one invocation —
        // route handler, workflow replay, inline steps, event writes — is a
        // single bounded trace. The run-origin context travels as a span
        // LINK (not a parent), and re-enqueues forward the original carrier
        // unchanged, so a (potentially hours-long) run is never stitched
        // into one giant trace across invocations.
        // 'continuous': legacy behavior — the restored run-origin context
        // becomes the parent of this invocation's spans.
        const traceMode = getWorkflowTraceMode();

        // Trace carrier to attach to messages this invocation enqueues —
        // see getNextTraceCarrier for the linked/continuous semantics.
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
        // active (parent) context — passing `undefined` makes
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
              // re-enqueued message (which carries none) — they only ever run on
              // a first delivery, the one that could create the run.
              //
              // Returning acks the message. That is deliberate: the mismatch is
              // baked into this message, so every redelivery would reach the
              // same verdict, and throwing would just hot-loop the handler until
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
              // Diagnostic only — see the helper for why this warns instead of
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
                  const replayRecoveryReporter = replayDivergence
                    ? new ReplayRecoveryReporter(replayDivergence.count)
                    : ReplayRecoveryReporter.inert();
                  // Every write this loop makes carries the cursor of the log
                  // it was computed against, and folds a complete returned
                  // delta into that log.
                  const createEvent = async <T extends CreateEventRequest>(
                    data: T,
                    params?: CreateEventParams
                  ) => {
                    const sinceCursor = deltaRequestCursor(data, params);
                    const withSnapshot = { ...slotSnapshot(), ...params };
                    const result = await replayRecoveryReporter.withEventCreate(
                      sinceCursor === undefined
                        ? withSnapshot
                        : { ...withSnapshot, sinceCursor },
                      (p) => world.events.create(runId, data, p)
                    );
                    if (sinceCursor !== undefined) {
                      absorbCreateDelta(sinceCursor, result);
                    }
                    return result;
                  };

                  /**
                   * The slot snapshot for a write issued from this loop: how
                   * much of the run's log the decision behind it was made
                   * against.
                   *
                   * Every write goes through here, including the ones that ask
                   * for an inline delta. The two answer different questions and
                   * a World is free to serve both: the cursor says where to
                   * start listing from, the slot says which events this writer
                   * had already decided without. Worlds that treat the delta as
                   * the better answer simply ignore the slot.
                   *
                   * Taken from whatever is loaded, including the stale
                   * `loadAfter` state. Understating is safe: the World reports
                   * back a wider span than strictly needed, and
                   * `mergeReportedEvents` drops what the log already holds.
                   * Overstating is not, so there is no guessing when nothing is
                   * loaded at all.
                   */
                  const slotSnapshot = (): SlotSnapshotParams =>
                    eventLog.type === 'loadAll'
                      ? {}
                      : slotSnapshotParams(eventLog.events);

                  /**
                   * The cursor to ask for an inline delta against, or
                   * undefined to not ask.
                   *
                   * Turbo is excluded on purpose: it exists to make the first
                   * invocation's writes as cheap as possible, and it has no
                   * loaded log to extend. Run-terminal writes are excluded
                   * because nothing reads the log afterwards, so the delta
                   * would be work the World does for no one. A caller that
                   * set its own `sinceCursor` (or asked for the `run_started`
                   * / `hook_received` preload, which owns the same response
                   * fields) keeps what it asked for.
                   */
                  const deltaRequestCursor = (
                    data: CreateEventRequest,
                    params: CreateEventParams | undefined
                  ): string | undefined => {
                    if (
                      turbo ||
                      eventLog.type !== 'ready' ||
                      params?.sinceCursor !== undefined ||
                      params?.preloadEvents === true ||
                      isTerminalRunEventType(data.eventType)
                    ) {
                      return undefined;
                    }
                    return eventLog.cursor ?? undefined;
                  };

                  /**
                   * Fold an inline delta returned by `events.create` into the
                   * in-memory event log.
                   *
                   * The delta is what `events.list({ cursor: sentCursor })`
                   * would have returned right after the write, so it carries
                   * back both our own event and anything another writer
                   * appended in band. Absorbing it here means the next reader
                   * already has the log and the loop's incremental
                   * `events.list` finds nothing left to fetch.
                   *
                   * Deliberately not `absorbSkippedSlotReport`, even though the
                   * `hasMore` half of the two policies coincides. A delta
                   * extends the tail and carries a cursor that has to move with
                   * it, so it appends without re-sorting and needs the cursor
                   * guard below; a skipped-slot report is a window strictly
                   * below the write, carries no cursor, and has to be sorted
                   * back into place. Sharing an implementation would mean one
                   * of them doing the other's work.
                   *
                   * Declining is always safe — an unabsorbed delta is a delta
                   * the next `events.list` returns — so the guards are free to
                   * be strict:
                   *
                   * - `hasMore` means the World truncated the page. Taking it
                   *   while advancing the cursor to the page end would be
                   *   fine, but taking it and NOT advancing would duplicate,
                   *   and the truncated case is rare enough not to special-case.
                   * - The cursor must be exactly where it was when the request
                   *   went out. Concurrent writes each diff against the cursor
                   *   they saw, and `appendUniqueEvents` deliberately does not
                   *   re-sort, so absorbing a second delta computed from an
                   *   older cursor could append events behind ones already
                   *   taken. First response back wins; the rest are dropped.
                   */
                  const absorbCreateDelta = (
                    sentCursor: string,
                    result: EventResult
                  ): void => {
                    if (
                      eventLog.type !== 'ready' ||
                      eventLog.cursor !== sentCursor ||
                      result.events === undefined ||
                      result.hasMore === true
                    ) {
                      return;
                    }
                    appendEventLog(eventLog, {
                      events: result.events,
                      cursor: result.cursor,
                    });
                  };

                  // `ready` can replay once without a read. The other states
                  // describe the next load exactly.
                  let eventLog: ReplayEventLog = { type: 'loadAll' };

                  // Shared state: set by either the background step path
                  // or the run_started setup below.
                  let workflowRun: WorkflowRun | undefined;
                  // Server-supplied per-run event ceiling from the run_started
                  // response. Undefined ⇒ no enforcement (older servers, turbo).
                  let maxEventsLimit: number | undefined;
                  let workflowStartedAt = -1;

                  // Latency telemetry (TTFS) state — see runtime/step-latency.ts.
                  // Whether this invocation's FIRST event snapshot contained
                  // nothing beyond run_created/run_started: anything else was
                  // written by an earlier invocation, whose contribution to
                  // time-to-first-step (including the queue hop back here)
                  // cannot be measured wall-clock, so TTFS is not reported.
                  // Set once, on the first iteration's loaded snapshot.
                  let invocationStartedClean: boolean | undefined;
                  // Epoch ms the `run_started` response was received/parsed
                  // by the SDK — anchors RSFS (run_started → first step's
                  // start POST). Set once, in the run_started setup below.
                  // Under turbo, run_started is backgrounded rather than
                  // awaited, so this is stamped at the point the run is
                  // synthesized locally instead of the real response — see
                  // StepLatencyTracking.rsfsAnchorMs.
                  let runStartedReceivedAtMs: number | undefined;
                  // Wall-clock ms spent committing hook_created events before
                  // the first step ran, accumulated across suspension passes
                  // and subtracted from TTFS. Accumulators here survive an
                  // in-process replay restart (a stale-snapshot rejection, or
                  // the attribute-event restart below), so a restarted
                  // invocation over-counts by the abandoned pass's hook time —
                  // the same slight over-count either restart has always had.
                  let preStepBlockingMs = 0;
                  // Snapshot of the accumulator as of the suspension that
                  // wrote the run's first attr_set (whose hook phase ran
                  // before its attr writes). When a pre-step setAttributes
                  // ends the TTFS measurement at the attr write, only hook
                  // time from BEFORE that point may be subtracted — later
                  // hook writes fall outside the measured window.
                  let preStepBlockingBeforeAttrMs: number | undefined;

                  // Turbo mode fast-paths the very first delivery of the very
                  // first invocation, where it is provably safe to: background
                  // `run_started`, skip the initial event-log load (nothing has
                  // been written yet), and force optimistic inline start (no
                  // concurrent peer handler exists to race the create-claim).
                  // `runInput` is only present on the start()-enqueued message,
                  // and `attempt === 1` (1-based) means this is the first
                  // delivery; `incomingStepId` would mark a background-step
                  // invocation and `replayDivergence` a recovery replay — both
                  // ineligible. The single-handler guarantee that makes forced
                  // optimistic start safe ends once a hook or wait is created
                  // (they introduce resume invocations), so turbo exits at that
                  // point (see `forceOptimisticStart`). Workflow attribute
                  // writes introduce no such invocation source — they resolve
                  // via an in-process replay and don't end turbo.
                  // NOTE: `metadata.attempt === 1` is also load-bearing for
                  // inline step ownership: owned-recovery steps (a step
                  // stamped by a PREVIOUS delivery of this message) can only
                  // exist on attempt ≥ 2, so turbo and owned recovery are
                  // mutually exclusive. The turbo `reinvoke()` paths (hook
                  // conflict, throttle backoff) ack this message and continue
                  // under a NEW message id — safe only because no
                  // non-terminal step can be inline-owned by the acked id
                  // when turbo is on. If turbo ever engages on redeliveries,
                  // those paths must first check for owned pending steps and
                  // fall back to `{ timeoutSeconds }` redelivery.
                  const turbo =
                    isTurboEnabled() &&
                    runInput !== undefined &&
                    metadata.attempt === 1 &&
                    incomingStepId === undefined &&
                    !replayDivergence;
                  span?.setAttributes(Attribute.WorkflowTurbo(turbo));

                  // Turbo mode only: resolves once the backgrounded
                  // `run_started` has landed (or rejects if it failed). Threaded
                  // into handleSuspension and executeStep so no step/hook/wait
                  // write races ahead of the run's creation. Undefined outside
                  // turbo, where `run_started` is awaited up front.
                  let runReadyBarrier: Promise<unknown> | undefined;

                  // Order a terminal run write (run_completed / run_failed) after
                  // the backgrounded run_started in turbo mode — a no-step
                  // workflow can otherwise reach run_completed before the run
                  // exists. Best-effort: a barrier rejection is swallowed for
                  // ordering only; if run_started truly failed the terminal write
                  // surfaces the real error (run not found / gone) and the message
                  // redelivers. No-op outside turbo.
                  const awaitRunReady = async (): Promise<void> => {
                    if (runReadyBarrier) {
                      try {
                        await runReadyBarrier;
                      } catch {
                        // intentional: ordering barrier only — see above.
                      }
                    }
                  };

                  // Re-invoke the orchestrator. Outside turbo this returns
                  // `{ timeoutSeconds }`, which makes the queue reschedule the
                  // CURRENT delivery's message. In turbo that is a trap: the
                  // current message carries `runInput`, and on async queues
                  // (e.g. graphile-worker) a reschedule comes back as delivery
                  // attempt 1 — so turbo re-engages, skips the event-log load
                  // again, replays against an empty log, never observes the
                  // hook event this invocation just wrote, and re-suspends
                  // forever (the run wedges). Under turbo we instead enqueue an
                  // explicit continuation that carries NO `runInput`, so the
                  // next delivery is a normal (non-turbo) load-and-replay that
                  // observes the committed events and makes progress; we then
                  // return `undefined` so the queue treats this delivery as done
                  // rather than also rescheduling it.
                  // Inline-ownership invariant guard: correlation IDs of
                  // steps whose bodies this invocation is executing under an
                  // ownership stamp (lazy inline + owned recovery), while the
                  // body is in flight. Crash recovery depends on the owning
                  // message NOT being acked while such a step is non-terminal
                  // (ack = handler return or reinvoke, which acks + enqueues
                  // under a NEW message id — the redelivery of the old id is
                  // what re-executes an orphaned owned step). All executeStep
                  // calls are awaited before any ack path runs, so this set
                  // is empty at every ack by construction; the check exists
                  // to catch future refactors that break that ordering.
                  const inFlightOwnedSteps = new Set<string>();
                  const assertNoInFlightOwnedSteps = (
                    ackPath: string
                  ): void => {
                    if (inFlightOwnedSteps.size > 0) {
                      runtimeLogger.error(
                        'Invariant violation: acking the workflow message while owned inline steps are still executing — crash recovery for these steps is broken',
                        {
                          workflowRunId: runId,
                          ackPath,
                          stepIds: [...inFlightOwnedSteps],
                        }
                      );
                    }
                  };

                  // A plain orchestrator-replay message. Omits `runInput` (it
                  // re-engages turbo on the next delivery and wedges the run —
                  // see `reinvoke` below) and `replayDivergence` /
                  // `serverErrorRetryCount` (this delivery chain's budgets).
                  const replayMessage =
                    async (): Promise<WorkflowInvokePayload> => ({
                      runId,
                      traceCarrier: await nextTraceCarrier(),
                      requestedAt: new Date(),
                    });

                  const reinvoke = async (
                    delaySeconds: number,
                    /**
                     * Extra fields to carry on the new message. Only reaches the
                     * next invocation on the turbo path: without turbo no
                     * message is enqueued at all — the handler returns a
                     * visibility timeout and the queue redelivers the CURRENT
                     * message, whose body (and therefore any counter on it)
                     * cannot be changed.
                     */
                    extraPayload?: Partial<WorkflowInvokePayload>
                  ): Promise<{ timeoutSeconds: number } | undefined> => {
                    assertNoInFlightOwnedSteps('reinvoke');
                    if (!turbo) return { timeoutSeconds: delaySeconds };
                    await queueMessage(
                      world,
                      getWorkflowQueueName(workflowName, namespace),
                      { ...(await replayMessage()), ...extraPayload },
                      delaySeconds > 0 ? { delaySeconds } : undefined
                    );
                    return undefined;
                  };

                  // Precondition (412) recovery: how many times this invocation
                  // has thrown away its replay and started over in-process.
                  let preconditionRestarts = 0;
                  /**
                   * Event ids the discarded replay held, kept until the next
                   * load resolves so a restart can report what its reload
                   * actually found. Without this a 412 only ever tells you that
                   * a restart happened, which conflates two very different
                   * situations: a log that grew (expected — the fence did its
                   * job) and a log that came back identical, which means client
                   * and backend disagree about the count for the same set of
                   * events and the restart will re-derive the same snapshot and
                   * be rejected again.
                   */
                  let preconditionRestartBaseline: {
                    ids: Set<string>;
                    restart: number;
                    reason: string;
                    source: 'inline-delta' | 'full-reload';
                  } | null = null;
                  /**
                   * Report what a stale-snapshot restart's reload found, once
                   * the log this replay will actually consume is in hand.
                   *
                   * `grew` is the expected case and gives 412 volume a
                   * denominator. `unchanged` means the reload disagreed with
                   * the rejection, so this replay re-derives the same snapshot
                   * and is rejected again until the budget is spent. `shrank`
                   * should be impossible: every load path only adds to a run's
                   * log.
                   */
                  const reportPreconditionRestartReload = (
                    events: Event[]
                  ): void => {
                    const baseline = preconditionRestartBaseline;
                    if (!baseline) return;
                    preconditionRestartBaseline = null;

                    const reloadedIds = new Set(
                      events.map((event) => event.eventId)
                    );
                    const added = countMissingIds(reloadedIds, baseline.ids);
                    const dropped = countMissingIds(baseline.ids, reloadedIds);
                    const outcome =
                      dropped > 0 ? 'shrank' : added > 0 ? 'grew' : 'unchanged';

                    runtimeLogger.warn(
                      'Restarted replay reloaded its event log after a stale-snapshot rejection',
                      {
                        workflowRunId: runId,
                        outcome,
                        added,
                        dropped,
                        eventsBefore: baseline.ids.size,
                        eventsAfter: reloadedIds.size,
                        preconditionRestarts: baseline.restart,
                        reason: baseline.reason,
                        source: baseline.source,
                        loopIteration,
                      }
                    );
                  };
                  /**
                   * Recover from a stale-snapshot rejection by restarting the
                   * replay inside this invocation, returning false when the
                   * per-invocation budget is spent (the caller then falls back
                   * to a fresh invocation).
                   *
                   * A 412 means the log this replay derived its events from was
                   * missing an event the backend had already recorded. The
                   * rejected write cannot simply be retried: correlation ids
                   * are positional ordinals of one seeded sequence, so a replay
                   * over the corrected log mints a different id for the same
                   * logical event, and re-posting this one would persist an
                   * event no correct replay ever produces. The whole replay has
                   * to be re-derived — which the loop does by discarding its
                   * cached log, since `runWorkflow` then builds a fresh VM,
                   * seed and correlation-id sequence from the reloaded events.
                   */
                  const restartReplayInProcess = (
                    reason: string,
                    error?: unknown,
                    /**
                     * Set false when writes this invocation made concurrently
                     * with the rejected one may be missing from the 412's
                     * delta: the World computed that delta against the
                     * rejected request's snapshot, so it cannot contain an
                     * event a sibling committed afterwards, and merging it
                     * would restart the replay on a log that is still
                     * incomplete. Only a full reload is authoritative then.
                     */
                    { allowDelta = true }: { allowDelta?: boolean } = {}
                  ): boolean => {
                    if (
                      preconditionRestarts >=
                      getPreconditionMaxInProcessRestarts()
                    ) {
                      return false;
                    }
                    preconditionRestarts++;
                    // Every stale-snapshot restart invalidates the parked VM:
                    // the log it consumed was missing events, so only a fresh
                    // replay over the corrected log is authoritative. This
                    // also covers the suspension-create 412, which fires
                    // before the retention decision (kill switch + step-input
                    // gate) ever ran, and the run_completed 412, where a
                    // completed session must not be resumed again.
                    retainedSession = null;
                    // A World MAY return the events we were missing on the 412.
                    // Trust it only on the FIRST restart: its completeness proof
                    // leans on the backend's own bookkeeping, so if that
                    // under-counts, a "complete" delta can still leave a hole.
                    // Bounding it to one attempt caps that at a single wasted
                    // restart; every later restart does the authoritative load.
                    const delta =
                      allowDelta && preconditionRestarts === 1
                        ? preconditionEventDelta(error, runId)
                        : null;
                    // A delta is only usable if there is a loaded log to merge
                    // it into; without one the restart must load everything.
                    const usedDelta =
                      delta !== null && eventLog.type !== 'loadAll';
                    // Snapshot the set being discarded while it is still in
                    // hand; the comparison happens once the next load resolves.
                    preconditionRestartBaseline =
                      eventLog.type !== 'loadAll'
                        ? {
                            ids: new Set(
                              eventLog.events.map((event) => event.eventId)
                            ),
                            restart: preconditionRestarts,
                            reason,
                            source: usedDelta ? 'inline-delta' : 'full-reload',
                          }
                        : null;
                    if (delta && eventLog.type !== 'loadAll') {
                      appendEventLog(eventLog, delta);
                      eventLog = { ...eventLog, type: 'ready' };
                    } else {
                      // MUST be a full, cursor-less reload. The cursor lists
                      // forward from the highest event id this replay holds,
                      // and what a stale snapshot is missing sits below it: a
                      // slot allocated inside a concurrent commit takes a
                      // position this replay had already read past. An
                      // incremental load starts above the hole and never
                      // returns it.
                      eventLog = { type: 'loadAll' };
                      // The corrected log inserts the missing events BELOW the
                      // length already scanned for payload prewarming, shifting
                      // every later position. Only a full rescan sees them.
                      replayPayloadCache.resetScan();
                    }
                    runtimeLogger.warn(
                      'Event creation rejected as stale; restarting replay in-process',
                      {
                        workflowRunId: runId,
                        reason,
                        loopIteration,
                        preconditionRestarts,
                        source: usedDelta ? 'inline-delta' : 'full-reload',
                      }
                    );
                    span?.setAttributes({
                      'workflow.precondition_restarts': preconditionRestarts,
                    });
                    return true;
                  };

                  /**
                   * Escalate a stale-snapshot rejection that survived the
                   * in-process restart budget to a fresh invocation, or give up
                   * on the run when the per-run budget is also spent.
                   *
                   * The in-process budget is a closure variable and the queue's
                   * delivery count restarts at 1 whenever a new message is
                   * enqueued, so a run that is permanently unable to catch up
                   * with its own event log would otherwise cycle restarts →
                   * re-invoke → restarts with no run-level bound. The chain is
                   * therefore counted on the message itself, in the same way
                   * replay divergences are, and fails the run once exhausted.
                   *
                   * The counter only advances on hops that enqueue a new message
                   * (see `reinvoke`). A redelivery-based hop keeps the same body
                   * and so the same count, but it also keeps advancing
                   * `metadata.attempt`, which the max-delivery check at the top
                   * of the handler already bounds — and the delay below is what
                   * makes that budget span real time rather than being burned in
                   * a tight loop.
                   */
                  const reinvokeAfterStaleRejection = async (
                    reason: string,
                    error: unknown
                  ): Promise<
                    | {
                        reinvoked: true;
                        result: { timeoutSeconds: number } | undefined;
                      }
                    | { reinvoked: false; error: Error }
                  > => {
                    const attempt = (preconditionReinvocations ?? 0) + 1;
                    const maxReinvocations = getPreconditionMaxReinvocations();
                    if (attempt > maxReinvocations) {
                      return {
                        reinvoked: false,
                        error: new WorkflowRuntimeError(
                          `Event creation was rejected as stale after ${maxReinvocations} re-invocations of ${getPreconditionMaxInProcessRestarts()} in-process replay restarts each: this run cannot observe its own event log completely enough to make progress. Last rejection (${reason}): ${error instanceof Error ? error.message : String(error)}`,
                          { cause: error }
                        ),
                      };
                    }
                    runtimeLogger.warn(
                      'Event creation rejected as stale after in-process restarts; re-invoking run for a fresh replay',
                      {
                        workflowRunId: runId,
                        reason,
                        loopIteration,
                        preconditionReinvocations: attempt,
                        maxReinvocations,
                      }
                    );
                    span?.setAttributes({
                      'workflow.precondition_reinvocations': attempt,
                    });
                    // Delayed, unlike the other reinvoke() callers: the
                    // in-process restarts already reloaded the log several times
                    // without catching up, so the writers this replay is racing
                    // are still active. Retrying instantly just burns the
                    // per-run budget at full speed.
                    return {
                      reinvoked: true,
                      result: await reinvoke(
                        getPreconditionReinvokeDelaySeconds(),
                        { preconditionReinvocations: attempt }
                      ),
                    };
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

                  // If incoming message has a stepId, this is a background step
                  // execution. Execute the step, then check if all parallel steps
                  // from the batch are done. If so, replay inline (saving a queue
                  // roundtrip). If not, return — the last handler to complete
                  // will pick up the replay.
                  if (incomingStepId && incomingStepName) {
                    try {
                      // Resilient step dispatch: the producer parallelized the
                      // `step_created` write with this queue publish, so the
                      // step entity may not exist yet when this delivery
                      // executes — the delivery beat the write, or the write
                      // failed transiently and this message carries the only
                      // copy of the input. Idempotently re-ensure the event
                      // from the message's `stepInput` — keyed by the step's
                      // correlation id, so the producer's write and this
                      // re-ensure converge on exactly one event.
                      //
                      // Invoked from two places:
                      //
                      //  - IN-BAND (the load-bearing path): when the bare
                      //    `step_started` below rejects with "step not found",
                      //    the executor catch materializes the step and
                      //    retries once, all within this delivery. This must
                      //    not rely on delivery attempts: world-vercel's
                      //    failure-retry path re-enqueues a FRESH message
                      //    (attempt resets to 1), so an attempt-gated recovery
                      //    is unreachable on the retry chain and the step
                      //    would stall until the ORIGINAL message's
                      //    ~300s visibility-timeout redelivery — measured
                      //    exactly so in the durabench parallel sweeps before
                      //    this path existed.
                      //  - EAGERLY on a genuine redelivery (attempt > 1),
                      //    in parallel with the run fetch below — a
                      //    redelivered dispatch already had its create race
                      //    resolved either way, so this saves the failed
                      //    start round-trip at no wall-time cost. First
                      //    deliveries skip it: the producer's write almost
                      //    always lands, and an eager ensure would burn a
                      //    conditional write per step.
                      const ensureStepFromMessage = async (): Promise<
                        'ok' | 'gone'
                      > => {
                        if (!stepInput) return 'ok';
                        try {
                          await world.events.create(
                            runId,
                            {
                              eventType: 'step_created',
                              specVersion: SPEC_VERSION_CURRENT,
                              correlationId: incomingStepId,
                              eventData: {
                                stepName: incomingStepName,
                                workflowName,
                                // Typed Uint8Array by StepDispatchInputSchema:
                                // a non-binary (mangled) payload fails the
                                // message parse above and never reaches this
                                // write.
                                input: stepInput.input,
                              },
                            },
                            {
                              requestId,
                              // Marks this create as a dispatch re-ensure so
                              // a guard-enforcing backend can refuse it when
                              // the producer's write was 412-rejected (the
                              // dispatch was revoked). Surfaces as
                              // RunExpiredError → 'gone' below, acking the
                              // message. Worlds without the guard ignore it.
                              viaStepDispatch: true,
                            }
                          );
                          // This delivery materialized the step — the
                          // completion of the producer's recovery path.
                          span?.setAttributes(
                            Attribute.StepResilientDispatchMaterialized(true)
                          );
                          runtimeLogger.warn(
                            'Materialized step_created from the queue message — the producer\u2019s direct write did not land',
                            {
                              workflowRunId: runId,
                              stepId: incomingStepId,
                              stepName: incomingStepName,
                            }
                          );
                        } catch (err) {
                          // The common case: the producer's write (or a
                          // concurrent re-ensure) already landed.
                          if (EntityConflictError.is(err)) return 'ok';
                          // Nothing left to execute: the run went terminal
                          // (matches the run-status check below), or a
                          // guard-enforcing backend revoked this dispatch
                          // (410 `step-dispatch-revoked` — the producer's
                          // write was 412-rejected and the replay restarted
                          // with a corrected schedule).
                          if (RunExpiredError.is(err)) return 'gone';
                          // Transient — rethrow so the queue redelivers and a
                          // later attempt converges instead of executing (and
                          // acking) a step that may not exist.
                          throw err;
                        }
                        return 'ok';
                      };
                      const [bgRun, ensureOutcome] = await Promise.all([
                        world.runs.get(runId, {
                          resolveData: 'none',
                        }),
                        stepInput && metadata.attempt > 1
                          ? ensureStepFromMessage()
                          : ('ok' as const),
                      ]);
                      if (ensureOutcome === 'gone') {
                        runtimeLogger.debug(
                          'Run already finished, skipping background step',
                          { workflowRunId: runId }
                        );
                        return;
                      }
                      if (bgRun.status !== 'running') {
                        runtimeLogger.debug(
                          'Run already finished, skipping background step',
                          { workflowRunId: runId, status: bgRun.status }
                        );
                        return;
                      }
                      // Covers every queued step execution — first dispatch and
                      // redeliveries/retries alike.
                      if (
                        (await guardDeployment(bgRun, async () => ({
                          ...(await replayMessage()),
                          stepId: incomingStepId,
                          stepName: incomingStepName,
                          // Carry the resume timing verbatim so the re-routed
                          // hop stays inside `step_dispatch` rather than
                          // vanishing from the TTR decomposition.
                          ...(hookResumeTiming ? { hookResumeTiming } : {}),
                        }))) !== 'continue'
                      ) {
                        return;
                      }
                      const bgStartedAt = bgRun.startedAt
                        ? +bgRun.startedAt
                        : Date.now();

                      // Retry ceiling for a backgrounded step. `metadata.attempt`
                      // (the queue delivery count) is a cheap upper bound, but it
                      // over-counts: a ThrottleError / TooEarlyError — or any
                      // redelivery that never ran the body — still advances it, so
                      // trusting it directly could fail a step as "exceeded max
                      // retries" before the body ever ran (a user-visible
                      // regression under transient backend pressure). Use it only
                      // as a fast gate: while it is at or under the ceiling the
                      // step cannot be exhausted, so proceed without touching the
                      // log. Only once it crosses the ceiling do we load the full
                      // event log and derive the authoritative attempt from the
                      // recorded `step_started` count — scoped to the lifecycle
                      // attempt total (bare starts plus the largest single
                      // owner's starts): throttle/too-early redeliveries write
                      // no start at all, racing invocations' one-off stamped
                      // duplicates don't accumulate (counting them falsely
                      // exhausted healthy steps — see countStepStartedEvents),
                      // and attempts burned under a prior inline-ownership
                      // phase still count, so a step that times out under
                      // owned recovery and then transitions to queued/bare
                      // retries trips the combined ceiling. This still bounds
                      // timeouts, which write no error for the post-body guard
                      // to catch.
                      let bgAuthoritativeAttempt = metadata.attempt;
                      const bgMaxRetries =
                        getStepFunction(incomingStepName)?.maxRetries ??
                        DEFAULT_STEP_MAX_RETRIES;
                      if (metadata.attempt > bgMaxRetries + 1) {
                        const loaded = await loadWorkflowRunEvents(runId);
                        bgAuthoritativeAttempt =
                          countStepStartedEvents(
                            loaded.events,
                            incomingStepId,
                            { type: 'totalAttempts' }
                          ) + 1;
                      }

                      // TTR: this delivery IS the dispatched next step of a
                      // resumption. Consume the tracking here so the inline
                      // replay this handler may fall through to cannot
                      // report it again.
                      const bgResumeTracking = resumeTracking;
                      resumeTracking = undefined;

                      // Pause the replay budget while the step body runs —
                      // step duration is bounded by the platform's function
                      // maxDuration, not by the replay timeout. See the
                      // ReplayBudget docs for the contract.
                      replayBudget.pause();
                      let stepResult: Awaited<ReturnType<typeof executeStep>>;
                      try {
                        // Single-flight: a delayed backstop (or retry) message
                        // can arrive while another execution of this same step
                        // is mid-body in this process — most importantly on
                        // worlds with no invocation kill bound (world-local),
                        // where the ownership lease is not a death proof. The
                        // loser awaits the winner's settlement, then acks
                        // without executing. No ownerMessageId here: the bare
                        // step_started of a queue-driven execution
                        // intentionally clears inline ownership (the step is
                        // queue-owned from this point).
                        const executeQueuedStep = () =>
                          executeStep({
                            world,
                            workflowRunId: runId,
                            workflowDeploymentId: bgRun.deploymentId,
                            workflowName,
                            workflowStartedAt: bgStartedAt,
                            requestId,
                            rootRunId: rootRunIdFrom(bgRun.attributes, runId),
                            stepId: incomingStepId,
                            stepName: incomingStepName,
                            runSpecVersion: bgRun.specVersion,
                            // Retry ceiling: the queue delivery count as a fast
                            // gate, verified against the recorded step_started
                            // count once it crosses the ceiling (see above).
                            authoritativeAttempt: bgAuthoritativeAttempt,
                            ...(bgResumeTracking
                              ? { resumeTracking: bgResumeTracking }
                              : {}),
                          });
                        stepResult = await runStepSingleFlight(
                          runId,
                          incomingStepId,
                          async () => {
                            try {
                              return await executeQueuedStep();
                            } catch (err) {
                              // In-band resilient recovery: a missing step on
                              // a stepInput-carrying message means this
                              // delivery outran (or outlived a transient
                              // failure of) the producer's parallel
                              // step_created write. Materialize the event
                              // from the payload and retry ONCE, within this
                              // delivery — see ensureStepFromMessage for why
                              // this cannot wait for a redelivery. A second
                              // failure propagates as before.
                              if (!stepInput || !isStepMissingError(err)) {
                                throw err;
                              }
                              if ((await ensureStepFromMessage()) === 'gone') {
                                return { type: 'gone' as const };
                              }
                              return await executeQueuedStep();
                            }
                          }
                        );
                      } finally {
                        replayBudget.resume();
                      }
                      if (stepResult.type === 'retry') {
                        return { timeoutSeconds: stepResult.timeoutSeconds };
                      }
                      if (stepResult.type === 'throttled') {
                        return { timeoutSeconds: stepResult.timeoutSeconds };
                      }

                      // If step had pending ops (stream writes), break and let
                      // waitUntil flush them — can't continue inline.
                      if (
                        stepResult.type === 'completed' &&
                        stepResult.hasPendingOps
                      ) {
                        await queueMessage(
                          world,
                          getWorkflowQueueName(workflowName, namespace),
                          {
                            runId,
                            traceCarrier: await nextTraceCarrier(),
                            requestedAt: new Date(),
                          }
                        );
                        return;
                      }

                      if (
                        stepResult.type === 'completed' ||
                        stepResult.type === 'failed' ||
                        stepResult.type === 'skipped'
                      ) {
                        // Load events to check if all parallel steps are done.
                        // Use cursor-based loading so the main loop can continue
                        // incrementally from here.
                        const loaded = await loadWorkflowRunEvents(runId);
                        eventLog = nextEventLogLoad(loaded);

                        // Check for pending steps: any step_created without
                        // a matching step_completed or step_failed.
                        const stepCreatedIds = new Set<string | undefined>();
                        const stepTerminalIds = new Set<string | undefined>();
                        for (const e of loaded.events) {
                          if (e.eventType === 'step_created') {
                            stepCreatedIds.add(e.correlationId);
                          } else if (
                            e.eventType === 'step_completed' ||
                            e.eventType === 'step_failed'
                          ) {
                            stepTerminalIds.add(e.correlationId);
                          }
                        }
                        const pendingStepIds = new Set<string | undefined>();
                        for (const id of stepCreatedIds) {
                          if (!stepTerminalIds.has(id)) {
                            pendingStepIds.add(id);
                          }
                        }

                        if (pendingStepIds.size > 0) {
                          // A pending step that THIS message inline-owns (a
                          // previous delivery of this message stamped its
                          // step_started and then crashed mid-body) must be
                          // recovered here: only the owning message may
                          // re-execute it before the ownership lease expires,
                          // and wake replays merely ensure a delayed
                          // backstop. Fall through to the main loop, whose
                          // dispatch table routes it to owned recovery.
                          if (
                            isInlineOwnershipEnabled() &&
                            hasPendingStepOwnedByMessage(
                              loaded.events,
                              pendingStepIds,
                              metadata.messageId
                            )
                          ) {
                            runtimeLogger.debug(
                              'Background step done; falling through to recover an inline step owned by this message',
                              { workflowRunId: runId }
                            );
                          } else {
                            // Other steps still in progress. Return without
                            // queuing — the last handler to complete will see
                            // all steps done and replay inline.
                            runtimeLogger.debug(
                              'Background step done but other steps pending, returning',
                              { workflowRunId: runId }
                            );
                            return;
                          }
                        }

                        // All steps done — fall through to the main replay loop.
                        // Set up shared state so the loop can continue.
                        runtimeLogger.debug(
                          'All parallel steps done, replaying inline after background step',
                          { workflowRunId: runId }
                        );
                        const runCreatedEvent = loaded.events.find(
                          (event) => event.eventType === 'run_created'
                        );
                        let replayInput: unknown;
                        if (runCreatedEvent) {
                          replayInput = runCreatedEvent.eventData.input;
                        } else {
                          if (!isLegacySpecVersion(bgRun.specVersion)) {
                            throw new WorkflowRuntimeError(
                              `Workflow run "${runId}" has no "run_created" event`
                            );
                          }
                          // Legacy runs predate the event-sourced run_created
                          // invariant, so retain the resolved GET only for them.
                          const legacyRun = await world.runs.get(runId, {
                            resolveData: 'all',
                          });
                          if (legacyRun.status !== 'running') {
                            return;
                          }
                          replayInput = legacyRun.input;
                        }
                        workflowRun = {
                          ...bgRun,
                          input: replayInput,
                          status: 'running',
                          output: undefined,
                          error: undefined,
                          completedAt: undefined,
                        };
                        workflowStartedAt = bgStartedAt;
                      } else {
                        return;
                      }
                    } catch (err) {
                      const errorCode = getWorkflowSetupErrorCode(err);
                      if (!errorCode) {
                        throw err;
                      }
                      await recordFatalRunError({
                        world,
                        workflowRun,
                        runId,
                        requestId,
                        err,
                        errorCode,
                        logMessage:
                          'Fatal error while preparing background workflow step',
                      });
                      return;
                    }
                  }

                  // Deployment-affinity pre-check for the lazy hook fast
                  // path below. New lazy-resume messages carry the run's
                  // pinned deployment (`hookInput.deploymentId`), so a
                  // misrouted delivery is detectable with a cheap ambient
                  // deployment-id comparison BEFORE the fast path's
                  // hook_received write — the correctly-routed common case
                  // pays no run fetch and no latency. Only a detected
                  // mismatch fetches the authoritative run and hands it to
                  // the existing guard (which owns re-route/fail policy);
                  // the re-routed message keeps the complete `hookInput`,
                  // since it may hold the only copy of the resume payload.
                  // When the pinned or ambient id is unavailable (older
                  // producer message, a world without deployment affinity,
                  // or a getDeploymentId failure), behavior is unchanged:
                  // the authoritative guard after run setup — which remains
                  // the protection before replay and step execution — still
                  // covers the delivery; the fast path's write is idempotent
                  // per (runId, resumeId), so a pre-guard write from an
                  // older message stays convergent.
                  if (
                    !workflowRun &&
                    hookInput?.deploymentId !== undefined &&
                    // Same eligibility as guardDeploymentAffinity: without
                    // atomic, immutable deployments the ids legitimately
                    // differ (e.g. dpl_local@<version>) and comparing them
                    // would trigger spurious run fetches.
                    world.capabilities?.deploymentAffinity === true
                  ) {
                    const pinnedDeploymentId = hookInput.deploymentId;
                    let currentDeploymentId: string | undefined;
                    try {
                      currentDeploymentId = await world.getDeploymentId();
                    } catch {
                      currentDeploymentId = undefined;
                    }
                    if (
                      currentDeploymentId !== undefined &&
                      currentDeploymentId !== pinnedDeploymentId
                    ) {
                      const run = await world.runs.get(runId, {
                        resolveData: 'none',
                      });
                      if (
                        (await guardDeployment(
                          run,
                          async () => ({
                            ...(await replayMessage()),
                            hookInput,
                            // Forwarded UNMODIFIED — in particular without
                            // this delivery's entry time — so the misrouted
                            // hop is attributed to `queue_delivery` and T2
                            // ends up being the final consumer's entry.
                            ...(hookResumeTiming ? { hookResumeTiming } : {}),
                          }),
                          awaitRunReady
                        )) !== 'continue'
                      ) {
                        return;
                      }
                    }
                  }

                  // --- Lazy hook resume fast path ---
                  // A lazy hook delivery (resumeId + digest on the queue
                  // message) hoists the consumer's idempotent hook_received
                  // re-ensure above run_started and asks the World to return
                  // the current replay log with the write (preloadEvents). A
                  // supporting World answers with the reconstructed run, the
                  // complete replay log, and the run's event ceiling —
                  // everything the generic setup below would spend a
                  // run_started POST and an events.list on. Any other result
                  // (older server, a World that ignores the param, or a
                  // preload that fails validation, including a bounded
                  // hasMore page) falls back to that generic setup; the
                  // hook_received write itself has still succeeded either
                  // way, so the re-ensure block below is skipped via
                  // `hookEnsured`. Never taken on turbo (turbo deliveries
                  // carry runInput, not hookInput) or after the background
                  // step path already loaded the run.
                  let hookEnsured = false;
                  if (
                    !workflowRun &&
                    hookInput &&
                    hookInput.resumeId !== undefined &&
                    hookInput.payloadDigest !== undefined
                  ) {
                    const hookResumeInput = hookInput;
                    // Date the materialized event to when the resume actually
                    // occurred — same derivation as the re-ensure below (the
                    // resumeId is a ULID minted by resumeHook() at resume
                    // time).
                    let occurredAt: Date | undefined;
                    try {
                      occurredAt = new Date(
                        decodeTime(hookResumeInput.resumeId)
                      );
                    } catch {
                      occurredAt = undefined;
                    }
                    try {
                      span?.addEvent('workflow.hook_received.create.start', {
                        'workflow.hook_received.preload_events': true,
                      });
                      const result = await createEvent(
                        {
                          eventType: 'hook_received',
                          specVersion: SPEC_VERSION_CURRENT,
                          correlationId: hookResumeInput.hookId,
                          eventData: {
                            token: hookResumeInput.token,
                            payload: hookResumeInput.payload,
                          },
                        },
                        {
                          requestId,
                          occurredAt,
                          resumeId: hookResumeInput.resumeId,
                          resumePayloadDigest: hookResumeInput.payloadDigest,
                          preloadEvents: true,
                        }
                      );
                      hookEnsured = true;
                      // Note: unlike the re-ensure below, this hoisted write
                      // does NOT set HookResilientResumeMaterialized — it
                      // runs on every fast-path resume, including the common
                      // case where the producer's direct write already landed
                      // and this call merely converged on it, so it carries
                      // no recovery signal. workflow.resume_setup_source
                      // (below) describes this path instead.

                      // The preload is usable as replay input only when it is
                      // demonstrably the complete picture: a reconstructed
                      // run with a start time, a non-empty COMPLETE log
                      // (hasMore false — this path has no cursor-continuation
                      // machinery, so a bounded page must not be trusted),
                      // the server's event ceiling (this response plays
                      // run_started's role, so a missing ceiling would leave
                      // event-limit enforcement disabled for the run),
                      // both run lifecycle events, the canonical event this
                      // write converged on, and the hook_received matching
                      // THIS resume (so we never replay against a log that is
                      // missing the very event that triggered this delivery).
                      const usableReplayPreload =
                        result.run !== undefined &&
                        result.run.startedAt !== undefined &&
                        result.event !== undefined &&
                        result.events !== undefined &&
                        result.events.length > 0 &&
                        result.cursor != null &&
                        result.hasMore === false &&
                        typeof result.maxEvents === 'number' &&
                        result.events.some(
                          (e) => e.eventType === 'run_created'
                        ) &&
                        result.events.some(
                          (e) => e.eventType === 'run_started'
                        ) &&
                        result.events.some(
                          (e) =>
                            e.eventType === 'hook_received' &&
                            e.resumeId === hookResumeInput.resumeId
                        );

                      if (
                        usableReplayPreload &&
                        result.run?.startedAt &&
                        result.events
                      ) {
                        // The reconstructed run always reads 'running', but a
                        // terminal event committed concurrently rides in the
                        // log itself. The node replay loop would catch it, but
                        // QuickJS dispatches before that check — so consume
                        // the delivery here, before any engine runs. Same
                        // outcome as the run_started path's non-running
                        // status check.
                        const terminalEvent = result.events.find(
                          (e) =>
                            e.runId === runId &&
                            (e.eventType === 'run_completed' ||
                              e.eventType === 'run_failed' ||
                              e.eventType === 'run_cancelled')
                        );
                        if (terminalEvent) {
                          // The preload still initialized this delivery (it
                          // is how the terminal state was observed), so the
                          // setup-source and the run's actual terminal
                          // status are recorded before consuming.
                          span?.setAttributes({
                            ...Attribute.WorkflowRunStatus(
                              terminalEvent.eventType === 'run_completed'
                                ? 'completed'
                                : terminalEvent.eventType === 'run_failed'
                                  ? 'failed'
                                  : 'cancelled'
                            ),
                            ...Attribute.HookResumeSetupSource(
                              'hook_received_stream'
                            ),
                          });
                          runtimeLogger.info(
                            'Run already finished during lazy hook setup, skipping',
                            {
                              workflowRunId: runId,
                              eventType: terminalEvent.eventType,
                            }
                          );
                          return;
                        }
                        workflowRun = result.run;
                        maxEventsLimit = clampMaxEvents(result.maxEvents);
                        // Anchors RSFS — see the declaration above. This
                        // response plays run_started's role on this path.
                        runStartedReceivedAtMs = Date.now();
                        if (resumeTracking) {
                          resumeTracking.setupSource = 'hook_preload';
                        }
                        eventLog = {
                          type: 'ready',
                          events: result.events,
                          cursor: result.cursor,
                        };
                        workflowStartedAt = +result.run.startedAt;
                        span?.setAttributes({
                          ...Attribute.WorkflowRunStatus(result.run.status),
                          ...Attribute.WorkflowStartedAt(workflowStartedAt),
                          ...Attribute.HookResumeSetupSource(
                            'hook_received_stream'
                          ),
                        });
                      } else {
                        // Successful write, no usable preload (CBOR response
                        // from an older server, a World that ignored the
                        // opt-in, a bounded hasMore page, or a preload that
                        // failed validation): take the generic run_started
                        // setup below. Its preload is loaded after this write
                        // committed, so the canonical hook_received is part
                        // of whatever log that setup reads — no splice
                        // needed.
                        span?.setAttributes(
                          Attribute.HookResumeSetupSource(
                            'hook_received_fallback'
                          )
                        );
                      }
                    } catch (err) {
                      // Same classification as the re-ensure below:
                      // - HookNotFound / RunExpired: the run went terminal;
                      //   nothing left to resume, consume the message.
                      // - anything else (EntityConflict, a truncated preload
                      //   stream, transport failures): transient — rethrow so
                      //   the queue redelivers and the idempotent
                      //   (runId, resumeId) claim converges on retry.
                      if (
                        HookNotFoundError.is(err) ||
                        RunExpiredError.is(err)
                      ) {
                        runtimeLogger.info(
                          'Run already finished during lazy hook setup, skipping',
                          { workflowRunId: runId, message: err.message }
                        );
                        return;
                      }
                      throw err;
                    }
                  }

                  // --- Infrastructure: prepare the run state ---
                  // Skip if workflowRun was already set by the background
                  // step path (inline replay after all parallel steps done)
                  // or by the lazy hook fast path above.
                  if (!workflowRun) {
                    // Always call run_started directly — this both transitions
                    // the run to 'running' AND returns the run entity, saving
                    // a separate runs.get round-trip.
                    // Contract: events.create('run_started') must be idempotent
                    // for runs already in 'running' status (return the run
                    // without error), not just for pending → running transitions.
                    const runStartedEvent = {
                      eventType: 'run_started' as const,
                      // Use the spec version from the original start() call
                      // when available, so the resilient start path creates
                      // the run with the correct version (not always current).
                      specVersion:
                        runInput?.specVersion ?? SPEC_VERSION_CURRENT,
                      // Pass run input from queue so the server can
                      // create the run if run_created was missed.
                      // Uint8Array values survive the queue natively
                      // (CBOR on world-vercel, JSON reviver on world-local).
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
                            },
                          }
                        : {}),
                    };
                    if (turbo && runInput) {
                      // Turbo: background `run_started` and synthesize the run
                      // entity locally so replay can begin without waiting for
                      // the round-trip. Safe here because this is the first
                      // delivery of the first invocation — start() created the
                      // run moments ago and no events have been written yet. The
                      // barrier is consumed by every downstream write (suspension
                      // handler, optimistic step_started, terminal run writes) so
                      // nothing is written before the run exists.
                      span?.addEvent('workflow.run_started.create.start', {
                        'workflow.run_started.skip_preload': true,
                      });
                      const startedPromise = createEvent(
                        runStartedEvent,
                        // We background this purely as a write barrier and
                        // never read its preloaded events, so skip the
                        // run_started event-log preload. That trims the
                        // run_started request the chained first step_started
                        // waits on — shortening time-to-second-step — and the
                        // wasted list+resolve it would otherwise compute.
                        { requestId, skipPreload: true }
                      );
                      runReadyBarrier = startedPromise;
                      // Turbo backgrounds run_started, so the non-turbo assignment
                      // below never runs — thread the per-run event ceiling off the
                      // backgrounded response here instead. The guard re-checks
                      // maxEventsLimit every loop iteration, so a value that lands
                      // shortly after start still enforces well before a runaway
                      // log approaches the ceiling.
                      void startedPromise
                        .then((r) => {
                          const limit = clampMaxEvents(r.maxEvents);
                          if (limit !== undefined) maxEventsLimit = limit;
                        })
                        // Prevent an early failure from surfacing as an
                        // unhandledRejection; runReadyBarrier still observes it.
                        .catch(() => {});
                      // Skip the initial events.list: nothing has been written to
                      // the log yet on a first delivery (run_started is still in
                      // flight). An empty preload routes iteration 1 through
                      // the no-load preloaded branch; iteration 2 then takes the
                      // existing post-preloaded full reload to pick up a cursor
                      // without a spurious "cursor missing" warning.
                      eventLog = {
                        type: 'ready',
                        events: [],
                        cursor: null,
                      };
                      const now = new Date();
                      workflowRun = {
                        runId,
                        status: 'running',
                        deploymentId: runInput.deploymentId,
                        workflowName: runInput.workflowName,
                        specVersion: runInput.specVersion,
                        executionContext: runInput.executionContext,
                        input: runInput.input,
                        // Seed attributes from start() ride along in `runInput`
                        // (they live in `run_created`'s eventData, not separate
                        // `attr_set` events), so the synthesized snapshot carries
                        // them even though we skip the initial events.list. This
                        // is correct ONLY while attributes are write-only:
                        // there is no in-workflow read API today (see workflow.ts
                        // "structural until a read API is introduced"), so the
                        // empty preloaded log can't diverge on a read. If a read
                        // API is ever added it MUST read from this snapshot, not
                        // by replaying run_created/attr_set events — otherwise
                        // turbo's empty initial log would surface seed attributes
                        // as `{}` on the first delivery only.
                        attributes: runInput.attributes ?? {},
                        startedAt: now,
                        createdAt: now,
                        updatedAt: now,
                      };
                      workflowStartedAt = +now;
                      // See the `runStartedReceivedAtMs` declaration above:
                      // turbo synthesizes the run before the real
                      // `run_started` response lands, so anchor RSFS here
                      // rather than at an actual response instant.
                      runStartedReceivedAtMs = +now;
                      span?.setAttributes({
                        ...Attribute.WorkflowRunStatus('running'),
                        ...Attribute.WorkflowStartedAt(workflowStartedAt),
                      });
                    } else {
                      try {
                        span?.addEvent('workflow.run_started.create.start', {
                          'workflow.run_started.skip_preload': false,
                        });
                        const result = await createEvent(runStartedEvent, {
                          requestId,
                        });
                        workflowRun = result.run;
                        maxEventsLimit = clampMaxEvents(result.maxEvents);
                        // Anchors RSFS — see the declaration above.
                        runStartedReceivedAtMs = Date.now();
                        // Covers both the plain sequential resume and the
                        // lazy fast path's fallback (whose hoisted write
                        // returned no usable preload and left workflowRun
                        // unset, so it lands here).
                        if (resumeTracking) {
                          resumeTracking.setupSource = 'run_started';
                        }

                        if (result.events?.length) {
                          const loaded = {
                            events: [...result.events],
                            cursor: result.cursor ?? null,
                          };
                          eventLog = result.hasMore
                            ? nextEventLogLoad(loaded)
                            : { ...loaded, type: 'ready' };
                        }
                        workflowStartedAt = +result.run.startedAt;
                        span?.setAttributes({
                          ...Attribute.WorkflowRunStatus(result.run.status),
                          ...Attribute.WorkflowStartedAt(workflowStartedAt),
                        });

                        if (result.run.status !== 'running') {
                          runtimeLogger.info(
                            'Workflow already completed or failed, skipping',
                            {
                              workflowRunId: runId,
                              status: result.run.status,
                            }
                          );

                          // TODO: for `cancel`, we actually want to propagate a WorkflowCancelled event
                          // inside the workflow context so the user can gracefully exit. this is SIGTERM
                          // TODO: furthermore, there should be a timeout or a way to force cancel SIGKILL
                          // so that we actually exit here without replaying the workflow at all, in the case
                          // the replaying the workflow is itself failing.

                          return;
                        }
                      } catch (err) {
                        // Run was concurrently completed/failed/cancelled
                        if (
                          EntityConflictError.is(err) ||
                          RunExpiredError.is(err)
                        ) {
                          // EntityConflictError: run was concurrently
                          // completed/failed/cancelled during setup.
                          // RunExpiredError: run already in terminal state.
                          // In both cases, skip processing this message.
                          runtimeLogger.info(
                            'Run already finished during setup, skipping',
                            { workflowRunId: runId, message: err.message }
                          );
                          return;
                        } else {
                          const errorCode = getWorkflowSetupErrorCode(err);
                          if (!errorCode) {
                            throw err;
                          }
                          await recordFatalRunError({
                            world,
                            workflowRun,
                            runId,
                            requestId,
                            err,
                            errorCode,
                            logMessage:
                              'Fatal runtime error during workflow setup',
                          });
                          return;
                        }
                      }
                    } // end else (non-turbo run_started)
                  } // end if (!workflowRun)
                  assert(
                    workflowRun,
                    'Workflow run must be loaded before replay'
                  );
                  // Neither setup branch ran, so the run arrived already
                  // loaded and setup was a plain event load. Only the
                  // background-step fall-through reaches here with a run
                  // preloaded today, and it consumes the tracking before this
                  // point — so this is the honest default rather than a live
                  // path, and keeps the dimension total if one is ever added.
                  if (
                    resumeTracking &&
                    resumeTracking.setupSource === undefined
                  ) {
                    resumeTracking.setupSource = 'event_load';
                  }

                  // Covers every flow replay — initial start, step completions,
                  // hook resumptions, wait completions — and stops before any
                  // workflow code or inline step executes when the run is not
                  // pinned here (see `guardDeploymentAffinity`). This remains
                  // the AUTHORITATIVE protection before replay and step
                  // execution. `awaitRunReady` orders turbo's `run_started`
                  // before either stopping action.
                  //
                  // Lazy hook resumes are additionally pre-checked above the
                  // fast path: a new message's `hookInput.deploymentId` is
                  // compared against the ambient deployment id for free, and
                  // only a detected mismatch fetches the authoritative run —
                  // so a misrouted modern resume re-routes with zero event
                  // writes. Older messages (no `hookInput.deploymentId`) reach
                  // the fast path's idempotent hook_received write before this
                  // guard; that write converges per (runId, resumeId) on the
                  // pinned deployment, so it is safe, just not free. Either
                  // way the re-routed message must carry `hookInput`, or a
                  // resume whose producer write had not yet landed would be
                  // lost.
                  if (
                    (await guardDeployment(
                      workflowRun,
                      async () => ({
                        ...(await replayMessage()),
                        ...(hookInput ? { hookInput } : {}),
                        // See the pre-check re-route above: forwarded as
                        // received, so the extra hop is queue delivery.
                        ...(hookResumeTiming ? { hookResumeTiming } : {}),
                      }),
                      awaitRunReady
                    )) !== 'continue'
                  ) {
                    return;
                  }

                  // Lazy hook resume: the producer (resumeHook fast path)
                  // parallelized the `hook_received` write with this queue
                  // publish, so the event may not be persisted yet. Idempotently
                  // ensure it before replay — keyed by `resumeId` so a
                  // concurrent producer write converges on exactly one event
                  // (the server resolves a matching claim as success, not an
                  // error). `hookInput` never rides a turbo first-delivery
                  // (that path carries `runInput`, not `hookInput`), so this
                  // only runs on the normal load-and-replay path. Skipped
                  // entirely when the fast path above already ensured the
                  // event (`hookEnsured`) — successfully or via its fallback,
                  // whose run_started preload was loaded after the write and
                  // therefore already contains the canonical event.
                  if (hookInput && !hookEnsured) {
                    // Perf (Option A): if the producer's concurrent direct
                    // write already landed in the run_started preload, the
                    // canonical event is in the log and the re-ensure round trip
                    // is pure overhead. Skip it when the preload already carries
                    // a `hook_received` with this resume's persisted `resumeId`
                    // (unique per resume, so we never skip on an unrelated
                    // hook_received). Best-effort: the win lands only when the
                    // producer's write beat this consumer's load; otherwise we
                    // fall through to the idempotent re-ensure below.
                    //
                    // Intentionally unreachable for atomic lazy resumes
                    // (resumeId + digest): those set `hookEnsured` in the
                    // hoisted fast path above — on success AND on its
                    // fallback — so this block (and the skip check) now only
                    // serves hookInput shapes without the full idempotency
                    // pair.
                    const alreadyPreloaded =
                      hookInput.resumeId !== undefined &&
                      eventLog.type !== 'loadAll' &&
                      eventLog.events.some(
                        (e) =>
                          e.eventType === 'hook_received' &&
                          e.resumeId === hookInput.resumeId
                      );
                    if (alreadyPreloaded) {
                      // Event already visible in the preloaded log — nothing to
                      // ensure or splice.
                    } else {
                      // Date the materialized event to when the resume actually
                      // occurred, not when this queue delivery ran. `resumeId`
                      // is the ULID minted by `resumeHook()` at resume time, so
                      // its embedded timestamp is the honest `occurredAt` and
                      // keeps latency attribution off the queue round trip. A
                      // non-ULID resumeId (legacy / test) simply leaves it
                      // undefined, so the World falls back to `createdAt`.
                      let occurredAt: Date | undefined;
                      try {
                        occurredAt =
                          hookInput.resumeId !== undefined
                            ? new Date(decodeTime(hookInput.resumeId))
                            : undefined;
                      } catch {
                        occurredAt = undefined;
                      }
                      let ensuredEvent: Event | undefined;
                      try {
                        const ensured = await world.events.create(
                          runId,
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
                        // Consumer-side completion of the recovery path: this
                        // replay materialized the event because the producer's
                        // direct write had not landed in the preload.
                        span?.setAttributes(
                          Attribute.HookResilientResumeMaterialized(true)
                        );
                        // The canonical event — whether this call committed it or
                        // converged on the producer's concurrent write — so we can
                        // splice it into the preloaded log instead of discarding
                        // the preload (see below).
                        //
                        // Reconstruct `eventData` from `hookInput` rather than
                        // trusting the POST response's payload: world-vercel posts
                        // hook_received with `remoteRefBehavior: 'lazy'`, so the
                        // returned event's payload is a RemoteRef *descriptor*, not
                        // the serialized bytes replay needs. `hookInput` carries
                        // the real token + payload bytes (they rode the queue
                        // message), so splice those onto the returned event's
                        // stable eventId/metadata.
                        // The re-ensure always returns a `hook_received` event, so
                        // the splice is safe. The cast is needed because spreading
                        // the raw `Event` union and overriding `eventData` collapses
                        // to a non-`hook_received` member (whose `eventData` is a
                        // different shape); the object is a genuine `hook_received`
                        // event by construction.
                        const base = ensured.event;
                        ensuredEvent = base
                          ? ({
                              ...base,
                              eventData: {
                                token: hookInput.token,
                                payload: hookInput.payload,
                              },
                            } as Event)
                          : undefined;
                      } catch (err) {
                        // A matching concurrent claim (same resumeId + digest) is
                        // resolved as success server-side and never throws, so
                        // anything caught here is a genuine terminal or transient
                        // condition:
                        //
                        // - HookNotFound / RunExpired: the producer's direct write
                        //   already ended this resume's eligibility (the run went
                        //   terminal). There is nothing left to resume, so consume
                        //   the message and stop. Continuing to replay would be
                        //   wasted work — and, worse, would ack a delivery that may
                        //   carry the only copy of the payload.
                        if (
                          HookNotFoundError.is(err) ||
                          RunExpiredError.is(err)
                        ) {
                          return;
                        }
                        // - EntityConflict (and any other unexpected error): the
                        //   resumeId constraint exists but the matching event is
                        //   not yet observable — the producer's parallel write is
                        //   still in flight, or a redrive raced the claim. This is
                        //   transient: rethrow so the queue redelivers and a later
                        //   attempt converges on the committed event instead of
                        //   replaying (and acking) without the payload.
                        throw err;
                      }
                      // The run_started response preloaded the log BEFORE this
                      // ensure, so it cannot include the hook_received. Rather
                      // than discard the preload (which would cost a fresh
                      // events.list round trip on the first replay iteration),
                      // splice in the canonical event reconstructed above. It
                      // carries a stable eventId, so `insertEventByEventId` keeps
                      // it in ascending eventId order and is idempotent if a later
                      // list re-observes it. Only when the World returns no event
                      // do we fall back to reloading the complete log.
                      if (eventLog.type !== 'loadAll' && ensuredEvent) {
                        insertEventByEventId(eventLog.events, ensuredEvent);
                      } else {
                        eventLog = { type: 'loadAll' };
                      }
                    } // end else (re-ensure needed)
                  }

                  // Resolve the encryption key for this run's deployment.
                  // Used eagerly here since both workflow execution (input
                  // hydration / hook payload decryption) and the run_failed
                  // dehydrate path below need it. Memoized accessor: first
                  // call triggers the actual fetch / HKDF derivation,
                  // subsequent calls await the cached promise.
                  const getEncryptionKey = memoizeEncryptionKey(
                    world,
                    workflowRun
                  );
                  const encryptionKey = await getEncryptionKey();

                  // Invocation-scoped cache of VM-independent prepared payloads
                  // and immutable final values. It survives the fresh workflow
                  // VM created by each inline replay, but never crosses runs or
                  // queue deliveries.
                  const replayPayloadCache = new ReplayPayloadCache(
                    encryptionKey
                  );

                  // The live VM parked at the previous boundary, when the
                  // retention decision kept it. null → this iteration cold-
                  // replays. Invocation-scoped: dies with this delivery.
                  let retainedSession: WorkflowSession | null = null;

                  // Main replay loop
                  // biome-ignore lint/correctness/noConstantCondition: intentional loop
                  while (true) {
                    loopIteration++;

                    // Replay-budget check: bail out (retry or fail) if
                    // non-step time within this invocation has exceeded
                    // the configured budget. Step bodies are excluded
                    // because replayBudget.pause()/resume() bracket every
                    // `executeStep` call.
                    if (replayBudget.isExhausted()) {
                      await handleReplayBudgetExhausted({
                        runId,
                        workflowName,
                        requestId,
                        attempt: metadata.attempt,
                        limitMs: replayBudget.configuredLimitMs,
                        slotSnapshot: slotSnapshot(),
                      });
                      // Only the terminal attempt returns, after run_failed is
                      // durable. Earlier attempts reject for queue redelivery.
                      return;
                    }

                    // Check timeout before replay
                    if (
                      Date.now() - invocationStartTime >=
                      noInlineReplayAfterMs
                    ) {
                      runtimeLogger.info(
                        'V2 timeout reached, re-scheduling workflow',
                        {
                          workflowRunId: runId,
                          loopIteration,
                          elapsedMs: Date.now() - invocationStartTime,
                        }
                      );
                      await queueMessage(
                        world,
                        getWorkflowQueueName(workflowName, namespace),
                        {
                          runId,
                          traceCarrier: await nextTraceCarrier(),
                          requestedAt: new Date(),
                        }
                      );
                      return;
                    }

                    let replayStart = 0;
                    try {
                      // --- QuickJS VM engine dispatch ---
                      // The QuickJS engine (opt-in via WORKFLOW_VM=quickjs
                      // or executionContext.workflowVm) is a self-contained
                      // alternative to the node:vm inline-replay logic
                      // below. It performs the same full event replay, but
                      // runs the workflow code in a QuickJS WASM VM, queues
                      // steps via the same combined route (so they hit
                      // executeStep below on re-entry), and manages its own
                      // run_completed / run_failed lifecycle for workflow
                      // outcomes. When the QuickJS engine is in effect,
                      // return immediately after dispatch.
                      //
                      // Deliberately INSIDE this try: engine failures that
                      // escape the entrypoint (MaxEventsExceededError, a
                      // WASM OOM at the memory ceiling, a bundle-eval
                      // failure) must reach this loop's catch so they are
                      // classified and recorded as run_failed — outside the
                      // try they would nack the message and burn all queue
                      // redeliveries before dying as
                      // MAX_DELIVERIES_EXCEEDED. Transient world errors
                      // still rethrow out of the catch for redelivery, same
                      // as node-engine replay failures.
                      if (useQuickJSVm(workflowRun)) {
                        runtimeLogger.debug('Using QuickJS VM engine', {
                          workflowRunId: runId,
                          loopIteration,
                        });
                        // Under turbo, run_started is backgrounded. The
                        // QuickJS entrypoint fetches the event log and
                        // writes events directly, so wait for the run to be
                        // durably started first — it does not thread the
                        // turbo runReadyBarrier the way handleSuspension
                        // does.
                        await awaitRunReady();
                        if (eventLog.type === 'loadAfter') {
                          appendEventLog(
                            eventLog,
                            await loadWorkflowRunEvents(runId, eventLog.cursor)
                          );
                          eventLog = { ...eventLog, type: 'ready' };
                        }
                        // Lazy import: the QuickJS entrypoint's import chain
                        // embeds the base64 WASM binary + extensions
                        // (~1.3 MB decoded at module scope). Loading it here
                        // keeps that out of node-engine deployments entirely
                        // — only the opt-in path pays, on first dispatch.
                        const { runWorkflowWithQuickJS } = await import(
                          './runtime/quickjs-entrypoint.js'
                        );
                        const quickjsResult = await runWorkflowWithQuickJS({
                          workflowCode,
                          workflowName,
                          workflowRun,
                          preloadedEvents:
                            eventLog.type === 'ready'
                              ? eventLog.events
                              : undefined,
                          preloadedEventsComplete: eventLog.type === 'ready',
                          runInput,
                          parentSpan: span,
                          maxEventsLimit,
                          namespace,
                          nextTraceCarrier,
                          // Inline-step ownership plumbing: redeliveries of
                          // this message drive crash recovery for steps an
                          // earlier invocation claimed inline (see the
                          // backstop pass in the entrypoint's loop), and
                          // the message id is stamped as `ownerMessageId`
                          // on inline lazy step claims so wake replays
                          // defer to the in-flight body instead of
                          // requeueing the step.
                          deliveryAttempt: metadata.attempt,
                          ownerMessageId: metadata.messageId,
                          requestId,
                        });
                        if (quickjsResult?.timeoutSeconds !== undefined) {
                          // Use `reinvoke` rather than returning
                          // `{ timeoutSeconds }` directly: under turbo the
                          // current message carries `runInput` and a
                          // reschedule would re-engage turbo on redelivery
                          // (replaying against a stale preloaded log and
                          // wedging the run — see the reinvoke() docs
                          // above). reinvoke enqueues an explicit
                          // continuation without `runInput` in that case.
                          return await reinvoke(quickjsResult.timeoutSeconds);
                        }
                        return;
                      }

                      if (eventLog.type !== 'ready') {
                        const page = await loadWorkflowRunEvents(
                          runId,
                          eventLog.type === 'loadAfter'
                            ? eventLog.cursor
                            : undefined
                        );
                        if (eventLog.type === 'loadAfter') {
                          appendEventLog(eventLog, page);
                          eventLog = { ...eventLog, type: 'ready' };
                        } else {
                          eventLog = { ...page, type: 'ready' };
                        }
                      }
                      assert(eventLog.type === 'ready');

                      reportPreconditionRestartReload(eventLog.events);

                      // Detect concurrent completion via the event log: if
                      // any other handler wrote a terminal run event, exit
                      // before doing replay work. The run entity's status is
                      // derived from these events, so checking the log here
                      // gives us the same signal as a runs.get() round-trip
                      // without the extra request per loop iteration.
                      if (hasRecordedTerminalRunEvent(eventLog.events, runId)) {
                        return;
                      }

                      // Complete elapsed waits
                      const now = Date.now();
                      const completedWaitIds = new Set(
                        eventLog.events
                          .filter((e) => e.eventType === 'wait_completed')
                          .map((e) => e.correlationId)
                      );
                      const waitsToComplete = eventLog.events
                        .filter(
                          (
                            e
                          ): e is Extract<
                            Event,
                            { eventType: 'wait_created' }
                          > & { correlationId: string } =>
                            e.eventType === 'wait_created' &&
                            e.correlationId !== undefined &&
                            !completedWaitIds.has(e.correlationId) &&
                            now >= (e.eventData.resumeAt as Date).getTime()
                        )
                        .map((e) => ({
                          eventType: 'wait_completed' as const,
                          specVersion: SPEC_VERSION_CURRENT,
                          correlationId: e.correlationId,
                          eventData: {
                            resumeAt: e.eventData.resumeAt,
                          },
                        }));

                      for (const waitEvent of waitsToComplete) {
                        try {
                          const created = await createEvent(waitEvent, {
                            requestId,
                          });
                          // Bump-and-report: fold what this write skipped over
                          // into the log, which is what `createEvent` reads the
                          // slot snapshot off, so each remaining wait asks for
                          // a slot above it.
                          //
                          // The truncated case matters twice over here. Beyond
                          // the position accounting `absorbSkippedSlotReport`
                          // rejects it for, the missing-completion check below
                          // decides from this log whether the handler still has
                          // to fetch, so a partial page would make the log look
                          // like it holds a completion whose page is unread and
                          // skip the fetch on a snapshot short of the World's.
                          absorbSkippedSlotReport(eventLog.events, created);
                        } catch (err) {
                          if (EntityConflictError.is(err)) {
                            runtimeLogger.info(
                              'Wait already completed, skipping',
                              {
                                workflowRunId: runId,
                                correlationId: waitEvent.correlationId,
                              }
                            );
                            continue;
                          }
                          throw err;
                        }
                      }
                      assert(eventLog.type === 'ready');

                      // The event list above may be stale by the time an
                      // elapsed wait is committed, and this replay has to see
                      // its own wait_completed before it can advance past the
                      // sleep. Each write asked the World for the delta since
                      // our cursor and folded it in (see createEvent), so a
                      // supporting World has already handed those events back
                      // and there is nothing left to do. Only fetch for the
                      // completions still missing locally: a World that
                      // ignores `sinceCursor`, a truncated delta, a concurrent
                      // absorb that lost the cursor race, or an
                      // EntityConflictError, whose rejection carries no delta.
                      const completedWaitIdsAfterWrites = new Set(
                        eventLog.events
                          .filter((e) => e.eventType === 'wait_completed')
                          .map((e) => e.correlationId)
                      );
                      const missingWaitCompletions = waitsToComplete.filter(
                        (waitEvent) =>
                          !completedWaitIdsAfterWrites.has(
                            waitEvent.correlationId
                          )
                      );

                      if (missingWaitCompletions.length > 0) {
                        // Load only events after the original snapshot cursor
                        // so concurrent durable events, such as hook_received,
                        // keep their ordering relative to wait_completed. Fall
                        // back to a full reload for older worlds that cannot
                        // give us a stable cursor, or if the cursor delta does
                        // not include the wait completion this handler just
                        // attempted.
                        if (eventLog.cursor) {
                          const page = await loadWorkflowRunEvents(
                            runId,
                            eventLog.cursor
                          );
                          const completedWaitIdsAfterCursor = new Set(
                            page.events
                              .filter((e) => e.eventType === 'wait_completed')
                              .map((e) => e.correlationId)
                          );
                          const sawAllWaitCompletions =
                            missingWaitCompletions.every((waitEvent) =>
                              completedWaitIdsAfterCursor.has(
                                waitEvent.correlationId
                              )
                            );

                          if (sawAllWaitCompletions) {
                            appendEventLog(eventLog, page);
                          } else {
                            eventLog = {
                              ...(await loadWorkflowRunEvents(runId)),
                              type: 'ready',
                            };
                          }
                        } else {
                          eventLog = {
                            ...(await loadWorkflowRunEvents(runId)),
                            type: 'ready',
                          };
                        }
                      }

                      // A replay reads the log as the complete record of what
                      // has happened, so a position nothing occupies is
                      // indistinguishable from an event that never occurred and
                      // the branch it would have decided gets decided the other
                      // way. Failing here is the difference between a run that
                      // reports its own corruption and one that silently
                      // returns the wrong answer.
                      //
                      // A hole that is merely a write mid-commit fills in on
                      // its own, so settleEventSlotGap re-reads before
                      // concluding, and adopts whichever log it settled on.
                      if (isSlotGapCheckEnabled()) {
                        const settled = await settleEventSlotGap(runId, {
                          events: eventLog.events,
                          cursor: eventLog.cursor,
                        });
                        eventLog = { ...settled.log, type: 'ready' };
                        if (settled.gap !== undefined) {
                          throw new CorruptedEventLogError(
                            `Event log for run ${runId} has a hole at slot ${settled.gap.firstMissingSlot}: ${settled.gap.missingCount} of the ${settled.gap.maxSlot} slots up to the log's maximum hold no event.`
                          );
                        }
                      }

                      // Completing elapsed waits refreshes the event snapshot.
                      // A concurrent handler may have written the terminal run
                      // event after the initial snapshot but before this
                      // replay. Once the event log records that outcome, this
                      // delivery is done.
                      if (hasRecordedTerminalRunEvent(eventLog.events, runId)) {
                        return;
                      }

                      // Event-limit guard: fail a runaway run once its log
                      // reaches the server-supplied ceiling (undefined ⇒ no
                      // enforcement). The throw is caught below and written as
                      // run_failed / MAX_EVENTS_EXCEEDED.
                      if (
                        maxEventsLimit !== undefined &&
                        eventLog.events.length >= maxEventsLimit
                      ) {
                        throw new MaxEventsExceededError(
                          eventLog.events.length,
                          maxEventsLimit
                        );
                      }

                      // Latency telemetry: judge TTFS eligibility against the
                      // invocation's first snapshot. Waits completed above
                      // would already disqualify via the event-type check, so
                      // evaluating after the wait pass is equivalent.
                      // attr_set is permitted: a redelivery can land after a
                      // committed pre-step attr_set, and the detour it marks
                      // is subtracted via preStepAttrStartMs regardless of
                      // which invocation wrote it (see runtime/step-latency.ts).
                      invocationStartedClean ??= eventLog.events.every(
                        (e) =>
                          e.eventType === 'run_created' ||
                          e.eventType === 'run_started' ||
                          e.eventType === 'attr_set'
                      );

                      runtimeLogger.debug('Starting workflow execution', {
                        workflowRunId: runId,
                        loopIteration,
                        eventCount: eventLog.events.length,
                        executionMode: retainedSession ? 'retained' : 'replay',
                      });
                      replayStart = Date.now();
                      // TTR T3. `??=` so it marks the FIRST replay pass of
                      // this invocation: a resume that needs more than one
                      // pass to reach its step (e.g. a pre-step
                      // `setAttributes` detour) reports the extra passes
                      // inside `replay`, keeping the phases additive.
                      if (resumeTracking) {
                        resumeTracking.replayStartedAtMs ??= replayStart;
                      }
                      // Start every missing decrypt/decompress operation up
                      // front (already-prepared payloads are skipped). Web
                      // Crypto work overlaps VM setup on the replay path and
                      // the appended events' consumption on the resume path;
                      // consumers still deserialize and resolve in event order.
                      const payloadPrewarm = replayPayloadCache.prewarm(
                        workflowRun,
                        eventLog.events
                      );
                      let workflowResult: WorkflowResumeResult = retainedSession
                        ? await resumeWorkflow(retainedSession, eventLog.events)
                        : { type: 'replay' };

                      if (workflowResult.type === 'replay') {
                        retainedSession = null;
                        workflowResult = await replayWorkflow({
                          workflowCode,
                          workflowRun,
                          events: eventLog.events,
                          encryptionKey,
                          replayPayloadCache,
                          // Turbo: the end-of-run drain inside workflow
                          // execution commits fire-and-forget `*_created`
                          // events before the terminal `awaitRunReady()` below.
                          runReadyBarrier,
                          worldCapabilities: world.capabilities,
                        });
                      }
                      await payloadPrewarm;

                      if (workflowResult.type === 'suspended') {
                        // Park the live session; the suspension catch below
                        // makes the one retention decision — keep it for the
                        // next iteration or discard it for a fresh replay.
                        retainedSession = workflowResult.session;
                        throw workflowResult.suspension;
                      }

                      const result = workflowResult.output;
                      runtimeLogger.debug('Workflow execution completed', {
                        workflowRunId: runId,
                        loopIteration,
                        replayMs: Date.now() - replayStart,
                        executionMode: retainedSession ? 'retained' : 'replay',
                      });
                      replayRecoveryReporter.activate();

                      // Workflow completed. Do NOT reload-and-retry the create
                      // in place: `result` was computed by this replay, so a
                      // stale (412) rejection must force a *fresh replay* (which
                      // may observe the new event and produce a different
                      // result), not re-commit the stale result. The catch below
                      // restarts the replay in-process.
                      try {
                        // Turbo: a workflow that finishes with no steps reaches
                        // here before the backgrounded run_started; order the
                        // terminal write after it so the run exists.
                        await awaitRunReady();
                        await createEvent(
                          {
                            eventType: 'run_completed',
                            specVersion: SPEC_VERSION_CURRENT,
                            eventData: { output: result },
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
                          return;
                        }
                        throw err;
                      }
                      dispatchRunCompletedHooks(runId);

                      span?.setAttributes({
                        ...Attribute.WorkflowRunStatus('completed'),
                      });
                      return;
                    } catch (err) {
                      if (WorkflowSuspension.is(err)) {
                        replayRecoveryReporter.activate();
                        // Synchronous workflow-execution duration for THIS
                        // suspension only — anchors the `finalSchedulingReplay`
                        // telemetry field below (see
                        // StepLatencyTracking.replayMs). This is the FINAL
                        // replay pass, the one that reached and scheduled the
                        // first step: valid rsfs paths can replay more than
                        // once before the first step (e.g. a workflow-body
                        // `setAttributes()` detour replays twice), and a
                        // redelivery omits earlier invocations' replay work
                        // entirely. This value is NOT accumulated across
                        // those earlier passes, so it must not be read as
                        // "the replay portion of rsfs" — rsfs covers the
                        // whole run_started-to-first-step window;
                        // finalSchedulingReplay covers only this last pass.
                        // Captured here, before `handleSuspension`'s awaited
                        // I/O, so it excludes that I/O.
                        //
                        // This duplicates what OTEL already captures on the
                        // run/invocation span, but is collected as client
                        // telemetry so the server can emit it as an
                        // UNSAMPLED, full-population metric: workflow-server's
                        // server spans are heavily sampled in production
                        // (~7%), and client spans can't be filtered by SDK
                        // version, so neither can serve as the dashboard's
                        // exact TTFS decomposition. On a retained-VM
                        // resume this measures the resume (typically ~0ms),
                        // not a replay, so the field's distribution is
                        // bimodal once retention is active.
                        const suspendedAtMs = Date.now();
                        const replayDurationMs = suspendedAtMs - replayStart;
                        // TTR T4 — the next durable step has been encountered.
                        // Gated on the suspension actually scheduling steps:
                        // a suspension that only creates hooks/waits has not
                        // reached a step, and a later pass may. Taken from
                        // the same instant as `replayDurationMs` so T4 can
                        // never precede T3.
                        if (resumeTracking && err.stepCount > 0) {
                          resumeTracking.nextStepEncounteredAtMs ??=
                            suspendedAtMs;
                        }
                        runtimeLogger.debug('Workflow suspended', {
                          workflowRunId: runId,
                          loopIteration,
                          replayMs: replayDurationMs,
                          steps: err.stepCount,
                          hooks: err.hookCount,
                          waits: err.waitCount,
                        });
                        const suspensionMessage =
                          buildWorkflowSuspensionMessage(
                            err.stepCount,
                            err.hookCount,
                            err.waitCount
                          );
                        if (suspensionMessage) {
                          runtimeLogger.debug(suspensionMessage);
                        }

                        // V2: handle suspension without queuing steps.
                        // Each event creation inside handleSuspension carries the
                        // precondition snapshot of the loaded event log, so a
                        // backend holding an event this replay never saw rejects
                        // the write (412) instead of accepting a divergent one.
                        // The rejection is handled here, by restarting the
                        // replay — never by re-posting the same event.
                        const suspensionStart = Date.now();
                        assert(
                          eventLog.type === 'ready',
                          'Workflow suspended before its event log was loaded'
                        );
                        let suspensionResult: Awaited<
                          ReturnType<typeof handleSuspension>
                        >;
                        try {
                          suspensionResult = await handleSuspension({
                            suspension: err,
                            world,
                            run: workflowRun,
                            span,
                            requestId,
                            eventLog,
                            runReadyBarrier,
                            replayRecoveryReporter,
                            // Resilient step dispatch: lets eligible newly
                            // created steps publish their step-execution
                            // message (carrying `stepInput`) in parallel with
                            // the step_created write. Steps queued there are
                            // reported back in `queuedStepCorrelationIds` and
                            // skipped by the dispatch pass below.
                            stepDispatch: {
                              queueName: getWorkflowQueueName(
                                workflowName,
                                namespace
                              ),
                              getTraceCarrier: nextTraceCarrier,
                            },
                            // Inline pre-claims: lets the batched fan-out
                            // fold the lazy-inline steps' step_created +
                            // step_started pairs — stamped with this
                            // message's ownership — into the one commit, so
                            // the bodies below start straight off it. See
                            // SuspensionHandlerResult.inlineClaims.
                            ownerMessageId: metadata.messageId,
                            // Let the fold return once the pair chunk has
                            // committed: trailing chunks and the per-chunk
                            // step-message publishes ride
                            // `deferredBatchWork`, which this invocation
                            // joins before it can ack (below, next to the
                            // dispatch join) — so the durability contract
                            // is unchanged while the bodies start earlier.
                            allowDeferredBatchWork: true,
                          });
                        } catch (suspensionError) {
                          // A suspension create was rejected as stale: re-derive
                          // the replay from a corrected log in this invocation.
                          // Once the in-process budget is spent, fall back to an
                          // explicit immediate re-invocation (a rethrow relies
                          // on redelivery of a message the turbo path already
                          // acked — the run would stall for the queue's ~300s
                          // default visibility timeout).
                          if (PreconditionFailedError.is(suspensionError)) {
                            if (
                              restartReplayInProcess(
                                'suspension-create',
                                suspensionError
                              )
                            ) {
                              continue;
                            }
                            const escalation =
                              await reinvokeAfterStaleRejection(
                                'suspension-create',
                                suspensionError
                              );
                            if (escalation.reinvoked) return escalation.result;
                            // Per-run budget spent: fail the run rather than
                            // hand it back to the queue to spin again.
                            throw escalation.error;
                          }
                          if (!FatalError.is(suspensionError)) {
                            // Transient failures propagate to the queue
                            // handler so the message is redelivered.
                            throw suspensionError;
                          }
                          // Non-retryable failure while committing the
                          // suspension's events — e.g. an attribute write
                          // the World rejected as invalid (the cumulative
                          // per-run cap can only be checked World-side).
                          // Redelivery would replay the workflow into the
                          // same write and the same rejection, so fail the
                          // run with the error instead of wedging the
                          // message in redelivery.
                          const errorCode = classifyRunError(suspensionError);
                          runtimeLogger.error(
                            'Non-retryable error while committing workflow suspension; failing run',
                            {
                              workflowRunId: runId,
                              errorCode,
                              errorName: suspensionError.name,
                              errorMessage: suspensionError.message,
                            }
                          );
                          try {
                            // Turbo: order the terminal write after the
                            // backgrounded run_started so the run exists.
                            await awaitRunReady();
                            await createEvent(
                              {
                                eventType: 'run_failed',
                                specVersion: SPEC_VERSION_CURRENT,
                                eventData: {
                                  error: await dehydrateRunError(
                                    suspensionError,
                                    runId,
                                    encryptionKey,
                                    globalThis,
                                    (workflowRun?.specVersion ?? 0) >=
                                      SPEC_VERSION_SUPPORTS_COMPRESSION
                                  ),
                                  errorCode,
                                },
                              },
                              { requestId }
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
                                  message: failErr.message,
                                }
                              );
                              return;
                            }
                            throw failErr;
                          }
                          dispatchRunFailedHooks(
                            runId,
                            suspensionError,
                            errorCode
                          );
                          span?.setAttributes({
                            ...Attribute.WorkflowRunStatus('failed'),
                            ...Attribute.WorkflowErrorCode(errorCode),
                            ...Attribute.WorkflowErrorName(
                              suspensionError.name
                            ),
                            ...Attribute.WorkflowErrorMessage(
                              suspensionError.message
                            ),
                            ...Attribute.ErrorType(suspensionError.name),
                          });
                          return;
                        }
                        if (suspensionResult.reportedEventCount > 0) {
                          // Bump-and-report merged events BELOW the tail and
                          // re-sorted the array to slot order, shifting every
                          // position the prewarm scan had already recorded.
                          // The cursor is deliberately left alone: the report
                          // is a lower bound on what was skipped, so the next
                          // incremental read still has to cover the same range.
                          replayPayloadCache.resetScan();
                        }

                        // Open hooks/waits in the log as loaded for this
                        // replay. This suspension's own hook/wait writes are
                        // NOT in it — they never reach retention anyway,
                        // because a suspension containing a non-step item
                        // fails canRetainWorkflowSession's type check before
                        // the scan is consulted. Computed
                        // lazily, at most once, and shared between the
                        // retention decision here and the delta/turbo gates
                        // below — the attr-detour and hook-conflict paths
                        // return/continue before the gates and usually
                        // short-circuit before ever scanning the log.
                        const openHookWait = once(() => {
                          assert(eventLog.type === 'ready');
                          return openHookAndWaitState(eventLog.events);
                        });

                        // The single retention decision: keep the parked
                        // session only across a pure step boundary with no
                        // out-of-band continuation source and provably
                        // passive step inputs.
                        if (
                          retainedSession &&
                          !canRetainWorkflowSession(
                            err,
                            suspensionResult.retainedStepInputsSafe,
                            openHookWait
                          )
                        ) {
                          retainedSession = null;
                        }
                        preStepBlockingMs += suspensionResult.hookCreationMs;
                        if (
                          suspensionResult.hasAttributeEvents &&
                          preStepBlockingBeforeAttrMs === undefined
                        ) {
                          preStepBlockingBeforeAttrMs = preStepBlockingMs;
                        }
                        runtimeLogger.debug('Suspension handled', {
                          workflowRunId: runId,
                          suspensionMs: Date.now() - suspensionStart,
                          pendingSteps: suspensionResult.pendingSteps.length,
                          timeoutSeconds: suspensionResult.waitTimeout?.seconds,
                          hasHookConflict: suspensionResult.hasHookConflict,
                          hasAwaitedHookCreation:
                            suspensionResult.hasAwaitedHookCreation,
                          hasAttributeEvents:
                            suspensionResult.hasAttributeEvents,
                        });

                        // Hook conflict: break loop, re-invoke via queue
                        if (suspensionResult.hasHookConflict) {
                          return await reinvoke(0);
                        }

                        // Native workflow attribute events are resolved
                        // through replay: the next loop iteration reloads the
                        // log (now holding the just-committed attr_set) and
                        // replays, resolving the setAttributes promise. Skip
                        // step processing for this pass so that replay decides
                        // races first — in Promise.race([setAttributes(),
                        // step()]), the durable attribute event must be able
                        // to win without executing the losing step. The replay
                        // happens in-process rather than via a queue
                        // re-invocation: unlike hooks and waits, an attr_set
                        // introduces no out-of-band invocation source that the
                        // handler would need to yield the message for, so
                        // paying a delivery round-trip here would only add
                        // latency before the workflow's next step.
                        if (suspensionResult.hasAttributeEvents) {
                          eventLog = nextEventLogLoad(eventLog);
                          continue;
                        }

                        // Steps whose arguments failed to serialize were
                        // finalized by the suspension handler as step_created
                        // + step_failed (see finalizeUnserializableStep). No
                        // step-execution message is dispatched for them, so
                        // when such a step is the only pending work nothing
                        // would ever re-invoke the run — replay in-process
                        // over the reloaded log instead. The replay rejects
                        // the step's promise with the SerializationError,
                        // which a try/catch around the step call observes;
                        // uncaught, it propagates out of the workflow body
                        // and fails the run as a USER_ERROR. Healthy sibling
                        // steps are not dispatched this pass: the replay
                        // re-suspends over their already-committed
                        // step_created events and the next pass dispatches
                        // them as usual.
                        if (
                          suspensionResult.failedStepCorrelationIds.size > 0
                        ) {
                          // Join the batched fan-out's trailing chunk commits
                          // and step-message publishes before continuing,
                          // exactly like the two joins on the dispatch paths
                          // below: this invocation must not proceed (and
                          // eventually ack) before every create and publish
                          // it launched is durable. A rejection propagates
                          // like theirs — transient world errors rethrow to
                          // the queue for redelivery.
                          await suspensionResult.deferredBatchWork;
                          // Inline steps whose pair-folded step_started this
                          // pass already committed (`inlineClaims`) are
                          // deliberately NOT executed on this pass: the
                          // forced replay below re-suspends over the same
                          // pending steps, and owned recovery (the claims
                          // carry this message's ownerMessageId) re-executes
                          // them there. Its "previous delivery crashed
                          // mid-body" log is a misnomer on this path —
                          // nothing crashed, the bodies were never started.
                          //
                          // The failed dehydration may have executed
                          // workflow-owned code (getters/proxies) before
                          // throwing; demote to a cold replay rather than
                          // resume a VM that may have diverged. This is a
                          // rare terminal-error path, so the replay cost is
                          // irrelevant next to the divergence risk.
                          retainedSession = null;
                          eventLog = nextEventLogLoad(eventLog);
                          continue;
                        }

                        const pendingSteps = suspensionResult.pendingSteps;

                        // Inline execution is gated on ownership. The
                        // suspension handler deferred the step_created write for
                        // up to `getMaxInlineSteps()` steps (`lazyInlineSteps`)
                        // so we can run them inline — in parallel — via lazy
                        // `step_started` events that create each step on the fly,
                        // saving one world round-trip per inline step. Ownership
                        // is still atomic and exactly-one per step: the world's
                        // create-claim inside each step_started returns
                        // `EntityConflictError` (→ executeStep `skipped`) to any
                        // concurrent loser, so only one handler ever runs a given
                        // body. Every other pending step keeps its eager
                        // step_created (in `createdStepCorrelationIds`) and is
                        // queued below.
                        //
                        // The suspension handler only designates
                        // `lazyInlineSteps` when no `hook.getConflict()` awaiter
                        // is present. That awaiter case must execute nothing
                        // inline: an inline `await executeStep(...)` blocks this
                        // handler for the full step duration, so the awaiter's
                        // continuation (which only advances on the next replay)
                        // would be serialized behind the step — defeating work
                        // the workflow expressed as parallel (e.g.
                        // `hook.getConflict().then(() => stepB())` racing `await
                        // stepA()`). In that case `lazyInlineSteps` is empty and
                        // every step is queued for re-invocation, which replays
                        // over the just-committed hook_created and resolves the
                        // awaiter while queued steps run in parallel invocations.
                        const lazyInlineSteps =
                          suspensionResult.lazyInlineSteps;
                        const inlineCorrelationIds = new Set(
                          lazyInlineSteps.map((s) => s.correlationId)
                        );

                        // Unified queue dispatch for everything we are NOT
                        // inline-executing. Steps are queued with stepId so
                        // the receiver runs them; the wait timer is queued
                        // as a generic continuation that fires after the
                        // wait elapses and lets the next replay observe the
                        // elapsed wait via the "complete elapsed waits"
                        // pass.
                        //
                        // Step dispatch decision table (per pending step not
                        // designated lazy-inline):
                        //
                        //   - Inline-owned, owner === this message  →
                        //     execute in THIS invocation (owned recovery: a
                        //     redelivery of the owning message re-executes
                        //     the step it crashed on, via a payload-less
                        //     step_started re-stamped with its
                        //     ownerMessageId — not a bare start).
                        //   - Inline-owned, owner !== this message  →
                        //     ensure a DELAYED backstop wake exists
                        //     (delaySeconds = ownership lease remaining)
                        //     instead of enqueueing the step. The owning
                        //     invocation is (likely) still running the body;
                        //     an immediate step message would bare-start the
                        //     running step and execute it a second time
                        //     (workflow#2780). The backstop is a plain run
                        //     continuation, NOT a step message: when it
                        //     fires, this same decision table handles
                        //     whatever state the step is in by then
                        //     (terminal → nothing pending; queue-owned after
                        //     step_retrying → normal keyed dispatch; owner
                        //     dead with lease expired → immediate dispatch,
                        //     preserving step-level failure semantics for
                        //     poison steps; lease refreshed by owner
                        //     recovery → re-arm). The backstop's
                        //     idempotencyKey is scoped to the ownership
                        //     EPOCH (latest step_started timestamp), NOT
                        //     just the correlation ID, and must never be
                        //     the step message's own key — see
                        //     backstopIdempotencyKey for both invariants
                        //     (fixed keys either absorb the retry handoff
                        //     or dedupe the refreshed-lease re-arm against
                        //     the in-flight backstop itself).
                        //   - Not owned (never stamped / eager / ownership
                        //     lapsed at step_retrying / lease expired /
                        //     kill-switched) → immediate enqueue, exactly as
                        //     before. This covers crash recovery: if a prior
                        //     handler wrote step_created but crashed before
                        //     queueing, a later handler queues it; the
                        //     step-identity-scoped idempotencyKey dedupes
                        //     redundant queues across concurrent handlers.
                        //
                        // The wait continuation is what makes
                        // `Promise.race(step, sleep)` behave correctly with
                        // inline step execution: even if the inline step
                        // blocks this handler for the full step duration,
                        // the wait timer fires in a separate function
                        // invocation. If the sleep wins, that parallel
                        // invocation completes the run; if the step wins,
                        // the wait continuation fires later and no-ops on
                        // the terminal run.
                        //
                        // The continuation's delay is clamped to the
                        // maximum queue delay (long waits chain across
                        // multiple hops) and its idempotency key dedupes
                        // re-observations of the same pending wait across
                        // suspension passes — see
                        // runtime/wait-continuation.ts for the full
                        // delay/key selection rationale.
                        const traceCarrier = await nextTraceCarrier();
                        const dispatches: Promise<unknown>[] = [];
                        const inlineOwnership = isInlineOwnershipEnabled();
                        const dispatchNowMs = Date.now();
                        const ownedRecoverySteps: StepInvocationQueueItem[] =
                          [];
                        let backstopWakesArmed = 0;
                        // TTR hand-off. The measurement may only go to an
                        // execution that will actually ATTEMPT the next
                        // durable step, and the loop below is what decides
                        // which those are — so the decision is made against
                        // its classification, never ahead of it.
                        //
                        // This invocation keeps the tracking whenever it will
                        // run something itself: a deferred lazy-inline step,
                        // or an owned-recovery step (a redelivery of the
                        // owning message re-executing the step it crashed
                        // on). Both land in `inlineExecutions` below and
                        // consume it there. Only when neither exists is it
                        // handed to the FIRST step this invocation actually
                        // enqueues as a step message.
                        //
                        // A step converted into a delayed backstop wake is
                        // NOT an attempt — the wake is a plain run
                        // continuation, and whichever invocation eventually
                        // runs the step is a different delivery — so it must
                        // not take the sample. If every pending step becomes
                        // a backstop, nothing here attempts the step and the
                        // resumption goes unreported, which is the honest
                        // outcome rather than a total attributed to work this
                        // delivery never did.
                        //
                        // Gated on there being a measurement to place at all:
                        // `&&` short-circuits, so a delivery carrying no
                        // tracking — every non-resume delivery, and every
                        // resume past the step that consumed it — never pays
                        // for the pending-step scan. That matters on wide
                        // fan-outs, where `pendingSteps` runs to hundreds.
                        let handOffResumeTiming =
                          resumeTracking !== undefined &&
                          lazyInlineSteps.length === 0 &&
                          !pendingSteps.some(
                            (step) =>
                              !inlineCorrelationIds.has(step.correlationId) &&
                              inlineOwnership &&
                              isStepOwnershipActive(step) &&
                              step.ownerMessageId === metadata.messageId
                          );
                        for (const step of pendingSteps) {
                          if (inlineCorrelationIds.has(step.correlationId)) {
                            continue;
                          }
                          // Already published by the suspension handler's
                          // resilient dispatch (create + queue in parallel,
                          // message carrying `stepInput`). A re-publish here
                          // would dedupe on the idempotency key anyway, but
                          // skip the wasted round-trip. Ownership never
                          // applies to these: they were created this pass, so
                          // no step_started stamp can exist yet.
                          if (
                            suspensionResult.queuedStepCorrelationIds.has(
                              step.correlationId
                            )
                          ) {
                            continue;
                          }
                          const ownershipActive =
                            inlineOwnership && isStepOwnershipActive(step);
                          if (
                            ownershipActive &&
                            step.ownerMessageId === metadata.messageId
                          ) {
                            // Owned recovery: this delivery IS the owning
                            // message; re-execute the step in this
                            // invocation instead of queueing it.
                            ownedRecoverySteps.push(step);
                            continue;
                          }
                          // Delayed backstop wake while another invocation's
                          // ownership lease is live; immediate step enqueue
                          // otherwise (lease expired ⇒ remaining 0 ⇒ same as
                          // today, which is also the degraded mode for
                          // worlds with unstable message IDs — the owner
                          // check above never matches there).
                          const backstopDelaySeconds = ownershipActive
                            ? stepLeaseRemainingSeconds(step, dispatchNowMs)
                            : 0;
                          if (backstopDelaySeconds > 0) {
                            backstopWakesArmed++;
                            runtimeLogger.debug(
                              'Pending step is inline-owned by a live invocation; ensuring delayed backstop wake instead of immediate requeue',
                              {
                                workflowRunId: runId,
                                stepId: step.correlationId,
                                ownerMessageId: step.ownerMessageId,
                                backstopDelaySeconds,
                              }
                            );
                            dispatches.push(
                              queueMessage(
                                world,
                                getWorkflowQueueName(workflowName, namespace),
                                {
                                  runId,
                                  traceCarrier,
                                  requestedAt: new Date(),
                                },
                                {
                                  delaySeconds: backstopDelaySeconds,
                                  idempotencyKey: backstopIdempotencyKey(step),
                                }
                              )
                            );
                            continue;
                          }
                          // This step IS being attempted, by the invocation
                          // that picks the message up. Consume the tracking
                          // here — the first such step and no other.
                          const stepResumeTiming = handOffResumeTiming
                            ? resumeTimingForMessage(resumeTracking)
                            : undefined;
                          if (stepResumeTiming) {
                            handOffResumeTiming = false;
                            resumeTracking = undefined;
                          }
                          dispatches.push(
                            queueMessage(
                              world,
                              getWorkflowQueueName(workflowName, namespace),
                              {
                                runId,
                                stepId: step.correlationId,
                                stepName: step.stepName,
                                traceCarrier,
                                requestedAt: new Date(),
                                ...(stepResumeTiming
                                  ? { hookResumeTiming: stepResumeTiming }
                                  : {}),
                              },
                              {
                                // Step-identity-scoped: dedupes against every
                                // other dispatch of THIS step (concurrent
                                // handlers, crash-recovery re-dispatch, the
                                // suspension handler's resilient publish)
                                // without absorbing a dispatch of a different
                                // step under a reassigned correlation id —
                                // see stepDispatchIdempotencyKey.
                                idempotencyKey: stepDispatchIdempotencyKey(
                                  step.correlationId,
                                  step.stepName
                                ),
                              }
                            )
                          );
                        }
                        if (suspensionResult.waitTimeout) {
                          dispatches.push(
                            queueMessage(
                              world,
                              getWorkflowQueueName(workflowName, namespace),
                              {
                                runId,
                                traceCarrier,
                                requestedAt: new Date(),
                              },
                              getWaitContinuationDispatch(
                                suspensionResult.waitTimeout.seconds,
                                suspensionResult.waitTimeout.correlationId
                              )
                            )
                          );
                        }
                        // The dispatch publishes and the inline bodies below
                        // run CONCURRENTLY: the suspension commit already made
                        // every dispatched step durable (and, when the fold
                        // engaged, settled the inline pairs' claims), which is
                        // the only ordering both sides need — so neither waits
                        // for the other. The joins below (before step results
                        // are read, and on the no-inline early returns) keep
                        // the failure contract: a dispatch rejection still
                        // fails this delivery, after in-flight bodies settle.
                        const dispatchesSettled = Promise.all(dispatches);
                        // A rejection must not surface as an unhandled
                        // rejection while the bodies run (or if setup between
                        // here and the join throws first); awaiting the
                        // original promise below still observes it.
                        dispatchesSettled.catch(() => {});

                        // The set of steps THIS invocation executes: the
                        // deferred lazy-inline batch plus any owned-recovery
                        // steps (this message's redelivery re-executing a
                        // step it crashed on — no lazyStepInput; the input
                        // hydrates from the step entity like the background
                        // path, and the payload-less step_started re-stamps
                        // ownership — unlike the background path's start it
                        // is NOT bare: it carries this message's
                        // ownerMessageId, which is also what the
                        // owned-recovery retry ceiling counts).
                        const inlineExecutions: Array<{
                          correlationId: string;
                          stepName: string;
                          lazyStepInput?: (typeof lazyInlineSteps)[number]['dehydratedInput'];
                          preclaimedStart?: PreclaimedInlineStart;
                        }> = [
                          ...lazyInlineSteps.map((s) => {
                            // Pre-claimed by the suspension batch: the pair
                            // already settled this step's create + claim, so
                            // the executor runs (or skips) the body off that
                            // verdict instead of sending a lazy start with
                            // the input.
                            const claim = suspensionResult.inlineClaims.get(
                              s.correlationId
                            );
                            return claim
                              ? {
                                  correlationId: s.correlationId,
                                  stepName: s.stepName,
                                  preclaimedStart: claim,
                                }
                              : {
                                  correlationId: s.correlationId,
                                  stepName: s.stepName,
                                  lazyStepInput: s.dehydratedInput,
                                };
                          }),
                          ...ownedRecoverySteps.map((s) => ({
                            correlationId: s.correlationId,
                            stepName: s.stepName,
                          })),
                        ];
                        // Ownership telemetry (design doc Phase 7): span
                        // attributes so production traces show when crash
                        // recovery ran or a wake was converted into a
                        // backstop, and a warn (always printed, unlike
                        // debug/info) for owned recovery — it means a prior
                        // delivery of this message died mid-step-body.
                        if (
                          backstopWakesArmed > 0 ||
                          ownedRecoverySteps.length > 0
                        ) {
                          span?.setAttributes({
                            ...(ownedRecoverySteps.length > 0
                              ? Attribute.WorkflowOwnedRecoverySteps(
                                  ownedRecoverySteps.length
                                )
                              : {}),
                            ...(backstopWakesArmed > 0
                              ? Attribute.WorkflowBackstopWakesArmed(
                                  backstopWakesArmed
                                )
                              : {}),
                          });
                        }
                        if (ownedRecoverySteps.length > 0) {
                          runtimeLogger.warn(
                            'Re-executing inline steps owned by this queue message — a previous delivery crashed mid-body and this redelivery is recovering them',
                            {
                              workflowRunId: runId,
                              stepIds: ownedRecoverySteps.map(
                                (s) => s.correlationId
                              ),
                            }
                          );
                        }

                        // Nothing to execute inline — everything has been
                        // queued (or no work needs scheduling). Exit and let
                        // the queue drive subsequent replays.
                        if (inlineExecutions.length === 0) {
                          // Nothing runs concurrently with the dispatches on
                          // this path — join them (and the fold's deferred
                          // chunk commits/publishes) here so a failure fails
                          // the delivery exactly as it always has.
                          await Promise.all([
                            dispatchesSettled,
                            suspensionResult.deferredBatchWork,
                          ]);
                          // A `hook.getConflict()` awaiter needs an immediate
                          // re-invocation: the replay consumes the
                          // just-committed hook_created and resolves the
                          // awaiter. Without it (no inline step, all work
                          // queued or none pending) the run would sit idle
                          // until some unrelated message woke it.
                          if (suspensionResult.hasAwaitedHookCreation) {
                            return await reinvoke(0);
                          }
                          return;
                        }

                        // Open hooks/waits are consulted by all three gates
                        // below; resolve the memoized scan once here.
                        const openHookWaitState = openHookWait.value;

                        // Inline-delta fast path gate. We request the delta —
                        // and on the next iteration consume it in place of the
                        // events.list — only when ALL hold:
                        //
                        //  - We have a real prior cursor to diff against (a
                        //    World may return none on the initial load).
                        //  - This is the clean single-step sequential case:
                        //    this suspension produced exactly one step and no
                        //    waits (`err.{step,wait}Count`), that one step is
                        //    the lone pending step (`pendingSteps.length === 1`)
                        //    and the lone inline step
                        //    (`lazyInlineSteps.length === 1` — no parallel
                        //    siblings queued to background handlers, and no other
                        //    inline step writing its own events out of band).
                        //  - No pending wait timer from THIS suspension, and no
                        //    open wait in the cumulative log. A `wait_completed`
                        //    is a resolution the replay is waiting on rather
                        //    than an event it can observe one iteration late,
                        //    so consuming a delta that predates it would settle
                        //    the sleep from a view that does not contain its
                        //    completion.
                        //  - An open (or this-suspension-created) hook is
                        //    fine, and that is the gate this used to carry.
                        //    The delta snapshots the log at the step_completed
                        //    write but is consumed on the next replay, so an
                        //    out-of-band `hook_received` landing in that window
                        //    is absent from the delta and observed one
                        //    iteration later than a real fetch would observe
                        //    it. That staleness is qualitatively the same
                        //    read-to-write race the fetch path already has (an
                        //    event can land right after `events.list` returns
                        //    and before the suspension's writes), and it is
                        //    bounded by the same thing: what a stale replay
                        //    holds is a *prefix* of the log, never a hole in
                        //    it, and replaying a prefix twice reaches the same
                        //    decisions. Its next write is allocated above
                        //    whatever it missed and comes back carrying it
                        //    (`reportSkippedSlots` on the local worlds,
                        //    commit-time allocation on the Vercel one), so the
                        //    replay corrects itself on the write rather than
                        //    on a read. A World MAY instead refuse the write as
                        //    stale (412), which the runtime handles the same
                        //    way; nothing requires it to. Hooks created by THIS
                        //    suspension are inside the delta (their
                        //    `hook_created` lands before the step-terminal
                        //    write), so only their `hook_received` responses
                        //    are subject to the same window.
                        //  - With no hook or wait open at all, the only
                        //    out-of-band writer is cancellation, which is safe
                        //    to observe one iteration late. See
                        //    openHookAndWaitState.
                        //
                        // When more than one step runs inline, each writes its
                        // own events and the per-write delta would be partial, so
                        // the delta is not requested (the gate below is false for
                        // multi-step) and the next iteration does a normal fetch.
                        const requestInlineDelta =
                          typeof eventLog.cursor === 'string' &&
                          err.stepCount === 1 &&
                          err.waitCount === 0 &&
                          pendingSteps.length === 1 &&
                          lazyInlineSteps.length === 1 &&
                          ownedRecoverySteps.length === 0 &&
                          !suspensionResult.waitTimeout &&
                          !openHookWaitState.openWait;

                        // Stale-sensitive batch: a hook is open in the run (or
                        // was created by this suspension, so its hook_received
                        // can land any moment) — an out-of-band event can make
                        // the view this batch was scheduled from stale, which
                        // is when several invocations race for one step's
                        // claim. Optimistic start begins the body before the
                        // claim settles, so the writer that LOSES the claim
                        // (`EntityConflictError` → `skipped`) has already run
                        // user code it does not own. Suppress it for these
                        // batches, so the body runs only after the claim came
                        // back won. Costs one claim round-trip per step while a
                        // hook is open, and buys the same thing on every World:
                        // a step body executes once per claim, not once per
                        // racer. (A World that refuses the claim as stale (412)
                        // gets the same protection through the same await;
                        // none of the shipped ones does that for a
                        // slot-numbered run.)
                        const suppressOptimisticStart =
                          openHookWaitState.openHook ||
                          err.hookCount > 0 ||
                          suspensionResult.hasHookEvents;

                        // Turbo mode forces optimistic inline start for this
                        // batch — but only while the run is still "clean" (a pure
                        // step suspension). The moment a hook or wait is
                        // created, later resume/parallel invocations become
                        // possible, so the single-handler guarantee that makes
                        // forced optimistic start safe no longer holds — turbo
                        // exits and the steps take the normal (env-gated)
                        // await-then-run path. The hook-conflict case already
                        // returned early above, the attr case continued into a
                        // fresh replay (so a batch-scheduling suspension never
                        // carries attr events), and the awaited-hook case
                        // emptied lazyInlineSteps; the checks below are
                        // defensive.
                        //
                        // The `suspensionResult.*` flags only reflect what THIS
                        // batch created, so they do not catch a hook/wait opened
                        // in an earlier iteration of the same delivery (e.g. a
                        // fire-and-forget `createHook(...)` that doesn't block the
                        // workflow, letting the replay loop continue to later pure
                        // step suspensions). Once any hook or wait is open in the
                        // cumulative log, resume/parallel invocations are possible
                        // for the rest of the run, so turbo must latch off
                        // permanently — checked here via `openHookAndWaitState`
                        // over the cumulative event log.
                        //
                        // NOTE: `WORKFLOW_SEQUENTIAL_REPLAYS=1` (per-run flow
                        // topics consumed with `maxConcurrency: 1`) would in
                        // principle waive this latch — serialized orchestrator
                        // invocations restore the single-handler guarantee for
                        // the whole delivery. The waiver is intentionally NOT
                        // taken: the env var is a runtime-process setting that
                        // cannot prove the BUILT flow trigger actually carries
                        // `maxConcurrency: 1` (it must be set at build time
                        // too, and some integrations write their own trigger
                        // config), and `capabilities.maxConcurrency` only
                        // declares queue support, not deployed configuration.
                        // Until the build emits a verifiable signal that the
                        // deployed trigger is serialized, the conservative
                        // latch stays.
                        const forceOptimisticStart =
                          turbo &&
                          !suspensionResult.hasAttributeEvents &&
                          !suspensionResult.waitTimeout &&
                          !suspensionResult.hasHookEvents &&
                          !suspensionResult.hasAwaitedHookCreation &&
                          !openHookWaitState.openHook &&
                          !openHookWaitState.openWait;

                        // Execute the inline steps in parallel. The replay
                        // budget is paused for the whole batch — step duration is
                        // bounded by the platform's function maxDuration, not the
                        // replay timeout — so the budget check at the top of the
                        // next loop iteration doesn't charge the step bodies.
                        // Latency telemetry: decide whether this batch's first
                        // step qualifies for TTFS/STSO measurement. Only the
                        // batch's first step carries the tracking so a
                        // parallel batch emits one sample per scheduling gap,
                        // not one per sibling. Turbo's synthesized run
                        // snapshot has a local-clock createdAt, so under
                        // turbo only the run-id ULID timestamp is trusted.
                        const latencyTracking = computeStepLatencyTracking({
                          events: eventLog.events,
                          invocationStartedClean:
                            invocationStartedClean === true,
                          runCreatedAtMs:
                            runIdCreatedAt(runId) ??
                            (turbo ? undefined : +workflowRun.createdAt),
                          runStartedReceivedAtMs,
                          replayMs: replayDurationMs,
                          preStepBlockingMs,
                          preStepBlockingBeforeAttrMs,
                          // This suspension's own hook/wait writes are not in
                          // the loaded event log yet, so report them explicitly.
                          suspensionHasWaits:
                            err.waitCount > 0 ||
                            suspensionResult.waitTimeout !== undefined,
                          suspensionCreatedHooks:
                            err.hookCount > 0 || suspensionResult.hasHookEvents,
                          turbo,
                        });

                        // Slot snapshot for the inline step_started claims: the
                        // lazy claim is the first durable write of a hot-path
                        // step (its step_created is deferred), so without a
                        // snapshot it would name no position at all and a stale
                        // replay could claim — and commit — a step scheduled off
                        // a view that misses an event it never loaded.
                        //
                        // Taken here rather than inside the executor because
                        // this is the view the scheduling decision was made
                        // against. The executor advances from it as its own
                        // writes land; see `slotSnapshot` in step-executor.
                        const loadedSlotSnapshot = slotSnapshotParams(
                          eventLog.events
                        );
                        // The batched fan-out's own events are not in the
                        // loaded log yet (the next iteration reloads), but
                        // this invocation wrote them — fold the batch's
                        // ceiling in, or every inline terminal write would
                        // name a pre-batch position and be answered with a
                        // skipped-slot report echoing the events this
                        // suspension just committed.
                        const batchSlotCeiling =
                          suspensionResult.batchCommittedSlotCeiling;
                        const inlineClaimSnapshot =
                          batchSlotCeiling !== undefined &&
                          batchSlotCeiling >
                            (loadedSlotSnapshot.eventCount ?? 0)
                            ? { eventCount: batchSlotCeiling }
                            : loadedSlotSnapshot;

                        // TTR: consumed by this batch. Every step is handed
                        // the SAME tracking object and its one-shot
                        // `reported` latch picks the single step that
                        // actually reaches user code — so the sample
                        // survives the batch's first step losing its atomic
                        // create-claim to a concurrent invocation while a
                        // sibling runs, without a parallel batch reporting
                        // once per sibling. Cleared here so a later loop
                        // iteration's steps — and any in-process replay
                        // restart — cannot report the same resumption again.
                        const batchResumeTracking = resumeTracking;
                        resumeTracking = undefined;

                        replayBudget.pause();
                        let stepResults: Awaited<
                          ReturnType<typeof executeStep>
                        >[];
                        const stepExecutionPromises = inlineExecutions.map(
                          (s, stepIndex) => {
                            const run = () => {
                              assert(eventLog.type === 'ready');
                              return executeStep({
                                world,
                                workflowRunId: runId,
                                workflowDeploymentId: workflowRun.deploymentId,
                                workflowName,
                                workflowStartedAt,
                                requestId,
                                rootRunId: rootRunIdFrom(
                                  workflowRun.attributes,
                                  runId
                                ),
                                stepId: s.correlationId,
                                stepName: s.stepName,
                                runSpecVersion: workflowRun.specVersion,
                                // Attempt number = prior step_started count + 1
                                // (this execution's start), counting only THIS
                                // message's own starts: the owned-recovery
                                // ceiling bounds how many times this owning
                                // message re-runs a step it crashed/timed out
                                // on, and each of those (re)starts stamps
                                // metadata.messageId. Starts written by racing
                                // invocations (stale/wake replays, a step
                                // message dispatched off a lost create-claim)
                                // carry other IDs — or none — and must not
                                // count, or the ceiling falsely exhausts a
                                // healthy step (see countStepStartedEvents).
                                // A lazy step is brand-new by construction (it
                                // enters the batch only when it has no
                                // step_created yet), so it has zero prior
                                // starts and is always attempt 1 — skip the
                                // log scan entirely. Only an owned-recovery
                                // re-run can have prior starts, and that path
                                // is uncommon, so reserve the O(n) scan for it
                                // rather than walking the growing log for
                                // every inline step (which would be O(n²)
                                // across a long sequential workflow).
                                authoritativeAttempt:
                                  s.lazyStepInput !== undefined ||
                                  s.preclaimedStart !== undefined
                                    ? 1
                                    : countStepStartedEvents(
                                        eventLog.events,
                                        s.correlationId,
                                        {
                                          type: 'ownedBy',
                                          messageId: metadata.messageId,
                                        }
                                      ) + 1,
                                // Lazy inline start: send the deferred step's
                                // input on step_started so the world creates
                                // the step on the fly. Absent for
                                // owned-recovery steps, whose input hydrates
                                // from the existing step entity, and for
                                // pre-claimed steps, whose pair already
                                // carried it.
                                lazyStepInput: s.lazyStepInput,
                                // Pre-claimed inline start: the suspension
                                // batch settled this step's create + claim;
                                // the executor runs (or skips) the body off
                                // that verdict with no start write of its own.
                                preclaimedStart: s.preclaimedStart,
                                // Inline ownership: stamp (or re-stamp) this
                                // invocation's queue message ID on the
                                // step_started, so wake replays see the body
                                // as in flight here and suppress the
                                // immediate requeue (workflow#2780).
                                ownerMessageId: metadata.messageId,
                                // Turbo: force optimistic start and hold the
                                // lazy step_started until the backgrounded
                                // run_started lands (the body still runs
                                // immediately). Both are undefined/false
                                // outside turbo.
                                forceOptimisticStart,
                                // Guard-enforced batches with an open hook
                                // await the claim before running the body, so
                                // a 412-fenced step never executes user code —
                                // see suppressOptimisticStart above.
                                suppressOptimisticStart,
                                runReadyBarrier,
                                slotSnapshot: inlineClaimSnapshot,
                                ...(stepIndex === 0 &&
                                (s.lazyStepInput !== undefined ||
                                  s.preclaimedStart !== undefined) &&
                                latencyTracking
                                  ? { latencyTracking }
                                  : {}),
                                ...(batchResumeTracking
                                  ? { resumeTracking: batchResumeTracking }
                                  : {}),
                                ...(requestInlineDelta && eventLog.cursor
                                  ? {
                                      inlineDeltaSinceCursor: eventLog.cursor,
                                    }
                                  : {}),
                                replayRecoveryReporter,
                              });
                            };
                            // Invariant bookkeeping: this invocation owns
                            // these bodies until they settle — see
                            // assertNoInFlightOwnedSteps.
                            inFlightOwnedSteps.add(s.correlationId);
                            // Lazy and pre-claimed steps are brand-new
                            // (their create-claim is the exactly-once gate),
                            // but an owned-recovery step already exists and
                            // its delayed backstop message may fire mid-body
                            // in this same process — route those through
                            // the in-process single-flight.
                            const executed =
                              s.lazyStepInput === undefined &&
                              s.preclaimedStart === undefined
                                ? runStepSingleFlight(
                                    runId,
                                    s.correlationId,
                                    run
                                  )
                                : run();
                            return executed.finally(() =>
                              inFlightOwnedSteps.delete(s.correlationId)
                            );
                          }
                        );
                        // The joins below sit BETWEEN these promises' creation
                        // and the `Promise.all` that reads them, so a body that
                        // rejects while a publish or a trailing chunk commit is
                        // still in flight would have no handler attached at the
                        // microtask checkpoint — an `unhandledRejection`, fatal
                        // under Node's default `--unhandled-rejections=throw`.
                        // A 412 stale-claim rejection races exactly that window.
                        // Attach now; every rejection is still observed by the
                        // awaits below, which are what decide the outcome.
                        for (const promise of stepExecutionPromises) {
                          promise.catch(() => {});
                        }
                        try {
                          // Join the dispatch publishes launched above and
                          // the fold's deferred batch work (trailing chunk
                          // commits + per-chunk step-message publishes) —
                          // the bodies are already running in parallel with
                          // both, and this invocation must not ack before
                          // every create and publish is durable. A failure
                          // keeps its old contract (fail this delivery so
                          // the message redelivers), but the in-flight
                          // bodies must settle first: an owned body left
                          // running past this handler would race its own
                          // redelivery.
                          try {
                            await Promise.all([
                              dispatchesSettled,
                              suspensionResult.deferredBatchWork,
                            ]);
                          } catch (dispatchErr) {
                            await Promise.allSettled(stepExecutionPromises);
                            throw dispatchErr;
                          }
                          stepResults = await Promise.all(
                            stepExecutionPromises
                          );
                        } catch (stepErr) {
                          // A stale (412) rejection of an inline step_started
                          // claim: the loaded view this batch was scheduled
                          // from is missing an event the backend already has,
                          // so the claim was fenced by the guard and no step
                          // events were written. Abandon the batch — any
                          // optimistic body result is discarded by executeStep's
                          // reconciliation — and restart the replay so it
                          // observes the missing event. Wait for the sibling
                          // executions to settle first so no owned body is in
                          // flight when the restart (or the ack path) runs.
                          if (PreconditionFailedError.is(stepErr)) {
                            const settled = await Promise.allSettled(
                              stepExecutionPromises
                            );
                            // A sibling whose claim was accepted wrote step
                            // events of its own, possibly after the World built
                            // this 412's delta — so that delta can no longer be
                            // assumed to complete the log, and the restart has
                            // to reload it in full. `skipped` (the step already
                            // existed), `gone` and `throttled` (claim rejected)
                            // wrote nothing.
                            const siblingWrote = settled.some(
                              (outcome) =>
                                outcome.status === 'fulfilled' &&
                                (outcome.value.type === 'completed' ||
                                  outcome.value.type === 'failed' ||
                                  outcome.value.type === 'retry')
                            );
                            if (
                              restartReplayInProcess('inline-claim', stepErr, {
                                allowDelta: !siblingWrote,
                              })
                            ) {
                              // The finally below resumes the replay budget
                              // before the next iteration starts.
                              continue;
                            }
                            // The finally below resumes the replay budget
                            // before this return (or throw) completes.
                            const escalation =
                              await reinvokeAfterStaleRejection(
                                'inline-claim',
                                stepErr
                              );
                            if (escalation.reinvoked) return escalation.result;
                            throw escalation.error;
                          }
                          throw stepErr;
                        } finally {
                          replayBudget.resume();
                        }

                        // Aggregate the batch results. `retry` steps (which
                        // already exist — their `step_started` succeeded) are
                        // re-queued per-step as background steps with their own
                        // delay; `throttled` steps (rejected on the create-claim,
                        // so never created) instead defer redelivery of this
                        // orchestrator message so they re-run inline with input
                        // on replay; completed/failed steps already wrote their
                        // terminal events. We only loop back to replay when every
                        // inline step reached a terminal state — otherwise the
                        // still-pending steps will be re-run by their queued retry
                        // messages and the background-step path replays once
                        // all steps are done.
                        const toRetry: {
                          step: (typeof inlineExecutions)[number];
                          delaySeconds: number;
                        }[] = [];
                        let anyPendingOps = false;
                        // A throttled inline step delays redelivery of THIS
                        // orchestrator message rather than being re-queued as a
                        // background step. Crucially, a `throttled` result means
                        // the lazy `step_started` was rejected on the atomic
                        // create-claim — so the step was NEVER created (no
                        // `step_created`, no step entity). Re-queuing it as a
                        // background step would send a bare `step_started` (no
                        // input), which the world rejects with `Step "<id>" not
                        // found` because it cannot lazily create the step without
                        // its input; that error isn't translatable, so the
                        // message redelivers until MAX_QUEUE_DELIVERIES and the
                        // step (and run) fail. Deferring redelivery of the
                        // orchestrator instead re-attempts the throttled step
                        // inline WITH its input on replay. We track the longest
                        // backoff so a batch with multiple throttles waits the
                        // max. Note: `retry` results are safe to re-queue as
                        // background steps because a retry implies `step_started`
                        // already succeeded and the step exists.
                        let throttleTimeout: number | undefined;
                        for (let i = 0; i < inlineExecutions.length; i++) {
                          const r = stepResults[i];
                          const s = inlineExecutions[i];
                          if (r.type === 'retry') {
                            toRetry.push({
                              step: s,
                              delaySeconds: r.timeoutSeconds,
                            });
                          } else if (r.type === 'throttled') {
                            throttleTimeout = Math.max(
                              throttleTimeout ?? 0,
                              r.timeoutSeconds
                            );
                          } else if (
                            r.type === 'completed' &&
                            r.hasPendingOps
                          ) {
                            anyPendingOps = true;
                          }
                        }

                        if (throttleTimeout !== undefined) {
                          // Defer redelivery of the orchestrator after the
                          // throttle backoff. On replay every non-terminal step
                          // is re-dispatched by the suspension handler: the
                          // still-throttled steps run inline again WITH their
                          // input (their `step_created` is deferred anew), and
                          // any `retry` steps in this batch are queued as
                          // background steps with their own retryAfter honored.
                          // Terminal steps (completed/failed/skipped/gone) are
                          // observed from their events and not re-run. Because
                          // the replay drives all remaining work, we must NOT
                          // also re-queue `toRetry` here — that would
                          // double-dispatch those steps.
                          //
                          // This returns BEFORE the `anyPendingOps` branch
                          // below, so a batch that mixes a throttle with a
                          // completed step that left unflushed ops does not
                          // queue the explicit flush continuation. That is safe
                          // because the throttle backoff (>= 1s) always exceeds
                          // the in-invocation flush window (<= 500ms + waitUntil),
                          // so ops settle before the post-backoff redelivery
                          // replays and reads them.
                          return await reinvoke(throttleTimeout);
                        }

                        if (toRetry.length > 0) {
                          const retryTraceCarrier = await nextTraceCarrier();
                          await Promise.all(
                            toRetry.map(({ step, delaySeconds }) =>
                              queueMessage(
                                world,
                                getWorkflowQueueName(workflowName, namespace),
                                {
                                  runId,
                                  stepId: step.correlationId,
                                  stepName: step.stepName,
                                  traceCarrier: retryTraceCarrier,
                                  requestedAt: new Date(),
                                },
                                {
                                  delaySeconds,
                                  // Key the delayed retry on the step's
                                  // dispatch key so it dedupes against the
                                  // keyed re-dispatch the suspension handler
                                  // performs on replay (it uses the same
                                  // stepDispatchIdempotencyKey).
                                  //
                                  // Without this, a mixed batch where one step
                                  // `completed` with unflushed background ops
                                  // (`anyPendingOps`) and another step is
                                  // retrying would double-dispatch the retry:
                                  // the `anyPendingOps` branch below queues an
                                  // immediate plain continuation, whose replay
                                  // sees the still-`retrying` step as pending
                                  // and re-dispatches it *immediately* and
                                  // *with* a key. Since this delayed retry had
                                  // no key, the two messages wouldn't dedupe —
                                  // the step would run twice, the configured
                                  // retry backoff would be ignored (plain
                                  // `Error` retries persist no `retryAfter`, so
                                  // the world has no `TooEarly` guard), and the
                                  // retry body could run early/concurrently.
                                  // Sharing the key lets the earlier delayed
                                  // message win, honoring the backoff.
                                  idempotencyKey: stepDispatchIdempotencyKey(
                                    step.correlationId,
                                    step.stepName
                                  ),
                                }
                              )
                            )
                          );
                        }

                        // Let pending background operations flush before the next
                        // replay reads their results.
                        if (anyPendingOps) {
                          runtimeLogger.debug(
                            'Breaking loop: inline step has pending ops',
                            { workflowRunId: runId, loopIteration }
                          );
                          await queueMessage(
                            world,
                            getWorkflowQueueName(workflowName, namespace),
                            {
                              runId,
                              traceCarrier: await nextTraceCarrier(),
                              requestedAt: new Date(),
                            }
                          );
                          return;
                        }

                        if (toRetry.length > 0) {
                          // Some inline steps will be re-run via their queued
                          // retry messages; the background-step path replays
                          // once all steps are terminal. Don't loop here — the
                          // retrying steps have no terminal event to observe yet.
                          return;
                        }

                        // All inline steps reached a terminal state
                        // (completed/failed/skipped/gone) — loop back to replay
                        // (the workflow observes the terminal events on replay).
                        //
                        // Reuse any inline delta. If it is partial, continue
                        // from its cursor instead of reading the page again.
                        if (inlineExecutions.length === 1) {
                          const only = stepResults[0];
                          if (only.type === 'completed' && only.inlineDelta) {
                            appendEventLog(eventLog, only.inlineDelta);
                            eventLog = only.inlineDelta.hasMore
                              ? nextEventLogLoad(eventLog)
                              : { ...eventLog, type: 'ready' };
                            continue;
                          }
                        }
                        eventLog = nextEventLogLoad(eventLog);
                      } else {
                        // Stale-snapshot rejection of a guarded write made
                        // directly by the replay loop — the result-bearing
                        // `run_completed`, or the `wait_completed` of the wait
                        // pass. Both reach this one catch and the rejection
                        // does not say which, hence the neutral label.
                        // Neither may be re-posted in place: the correlation id
                        // and (for run_completed) the result itself came from
                        // this replay, and a corrected log may produce
                        // different ones. Don't fail the run — restart the
                        // replay in this invocation, and only once that budget
                        // is spent schedule an explicit re-invocation.
                        // Rethrowing instead would rely on redelivery of the
                        // CURRENT message, which the turbo path has already
                        // acked — empirically the run then stalls for the
                        // queue's ~300s default visibility timeout before
                        // completing.
                        let terminalError = err;
                        if (PreconditionFailedError.is(err)) {
                          if (restartReplayInProcess('replay-write', err)) {
                            continue;
                          }
                          const escalation = await reinvokeAfterStaleRejection(
                            'replay-write',
                            err
                          );
                          if (escalation.reinvoked) return escalation.result;
                          // Per-run budget spent. Fall through to the terminal
                          // path below instead of rethrowing: this catch owns
                          // failing the run, and a rethrow would escape to the
                          // queue handler and be redelivered.
                          terminalError = escalation.error;
                        }

                        // Transient infrastructure failures talking to the
                        // world (workflow-server) — an exhausted RetryAgent
                        // (UND_ERR_REQ_RETRY from a sustained 429/503 storm),
                        // a dropped socket, a connect/DNS failure, or a client
                        // timeout — must NOT fail the run. Rethrow so the queue
                        // redelivers and a fresh invocation retries the replay
                        // once the backend recovers. The @vercel/queue handler
                        // applies a fast (1s→60s) backoff by delivery count,
                        // avoiding the ~5min default visibility-timeout redrive
                        // (and never killing the process via run_failed).
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

                        let replayDivergenceCountForFailure: number | undefined;
                        if (ReplayDivergenceError.is(err)) {
                          const divergenceCount =
                            (replayDivergence?.count ?? 0) + 1;
                          const maxRecoveryReplays =
                            getReplayDivergenceMaxRetries();

                          if (divergenceCount <= maxRecoveryReplays) {
                            runLogger.warn(
                              'Workflow replay diverged; queueing a recovery replay before declaring the event log corrupted',
                              {
                                errorCode: RUN_ERROR_CODES.REPLAY_DIVERGENCE,
                                divergenceEventId: err.eventId,
                                priorDivergenceEventId:
                                  replayDivergence?.eventId,
                                divergenceCount,
                                deliveryAttempt: metadata.attempt,
                                maxRecoveryReplays,
                                errorMessage: err.message,
                              }
                            );
                            await queueMessage(
                              world,
                              getWorkflowQueueName(workflowName, namespace),
                              {
                                runId,
                                traceCarrier: await nextTraceCarrier(),
                                requestedAt: new Date(),
                                replayDivergence: {
                                  eventId: err.eventId,
                                  count: divergenceCount,
                                },
                              }
                            );
                            return;
                          }

                          replayDivergenceCountForFailure = divergenceCount;
                          terminalError = new CorruptedEventLogError(
                            `Workflow replay diverged ${divergenceCount} times after ${maxRecoveryReplays} recovery replays; latest divergent event was ${err.eventId}. Last divergence: ${err.message}`,
                            { cause: err }
                          );
                        } else if (replayStart > 0) {
                          replayRecoveryReporter.activate();
                        }

                        // User code errors and terminal runtime errors fail the run.
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
                            workflowCode
                          );
                        }

                        // Classify the error: WorkflowRuntimeError indicates
                        // an SDK/runtime issue, and selected subclasses use
                        // more specific codes for backend tracking.
                        const errorCode = classifyRunError(terminalError);

                        runtimeLogger.error('Error while running workflow', {
                          workflowRunId: runId,
                          errorCode,
                          errorName,
                          errorStack,
                        });

                        // Apply the source-map-remapped stack to the thrown
                        // value so that the serialized error preserves it
                        // for consumers. `types.isNativeError()` is used
                        // instead of `err instanceof Error` because the
                        // workflow runs in a separate VM realm — its Error
                        // class is distinct from the host's, so `instanceof
                        // Error` is `false` for VM-thrown errors. The V8
                        // type tag works across realms.
                        if (types.isNativeError(terminalError) && errorStack) {
                          (terminalError as Error).stack = errorStack;
                        }

                        // Fail the workflow run via event (event-sourced).
                        // Serialize the original thrown value so its full
                        // type identity and custom properties round-trip
                        // through the event log.
                        //
                        // Like every other write from this loop it carries the
                        // slot snapshot, so a World that fences can reject it
                        // and a slot-allocating one reports back what the
                        // failing replay had not seen. Fail-open on purpose
                        // where neither applies: a spurious failure is
                        // recoverable (the run can be re-run from the
                        // dashboard), whereas a spurious *completion* commits a
                        // wrong result.
                        try {
                          // Turbo: order the terminal write after the
                          // backgrounded run_started so the run exists.
                          await awaitRunReady();
                          await createEvent(
                            {
                              eventType: 'run_failed',
                              specVersion: SPEC_VERSION_CURRENT,
                              eventData: {
                                error: await dehydrateRunError(
                                  terminalError,
                                  runId,
                                  encryptionKey,
                                  globalThis,
                                  (workflowRun?.specVersion ?? 0) >=
                                    SPEC_VERSION_SUPPORTS_COMPRESSION
                                ),
                                errorCode,
                              },
                            },
                            {
                              requestId,
                              ...(replayDivergenceCountForFailure !== undefined
                                ? {
                                    replayDivergenceCount:
                                      replayDivergenceCountForFailure,
                                  }
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
                                message: failErr.message,
                              }
                            );
                            return;
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
                            return;
                          }
                          throw failErr;
                        }
                        dispatchRunFailedHooks(runId, terminalError, errorCode);

                        span?.setAttributes({
                          ...Attribute.WorkflowRunStatus('failed'),
                          ...Attribute.WorkflowErrorCode(errorCode),
                          ...Attribute.WorkflowErrorName(errorName),
                          ...Attribute.WorkflowErrorMessage(errorMessage),
                          ...Attribute.ErrorType(errorName),
                        });
                        return;
                      }
                    }
                  }
                }
              );
            }
          );
        });
      }
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
            const worldHandlers = await trace(
              'workflow.route.get_world_handlers',
              async () => getWorldHandlers()
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
