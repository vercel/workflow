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
  getQueueTopicPrefix,
  isLegacySpecVersion,
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
  appendUniqueEvents,
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  insertEventByEventId,
  isPreconditionGuardEnabled,
  type LoadedEventLog,
  loadWorkflowRunEvents,
  memoizeEncryptionKey,
  parseHealthCheckPayload,
  preconditionEventDelta,
  preconditionSnapshotParams,
  queueMessage,
  withHealthCheck,
} from './runtime/helpers.js';
import {
  handleReplayBudgetExhausted,
  ReplayBudget,
} from './runtime/replay-budget.js';
import { ReplayRecoveryReporter } from './runtime/replay-recovery-reporter.js';
import { runIdCreatedAt } from './runtime/run-id-time.js';
import {
  DEFAULT_STEP_MAX_RETRIES,
  executeStep,
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

  const NO_INLINE_REPLAY_AFTER_MS =
    Number(process.env.WORKFLOW_V2_TIMEOUT_MS) || 120_000;

  const namespace = resolveQueueNamespace(options?.namespace);
  const workflowPrefix = getQueueTopicPrefix('workflow', namespace);

  const handler = (worldHandlers: WorldHandlers) =>
    worldHandlers.createQueueHandler(
      workflowPrefix,
      async (message_, metadata) => {
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
          runInput,
          hookInput,
        } = WorkflowInvokePayloadSchema.parse(message_);
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
                  let loopIteration = 0;
                  const replayRecoveryReporter = replayDivergence
                    ? new ReplayRecoveryReporter(replayDivergence.count)
                    : ReplayRecoveryReporter.inert();
                  const createEvent = <T extends CreateEventRequest>(
                    data: T,
                    params?: CreateEventParams
                  ) =>
                    replayRecoveryReporter.withEventCreate(params, (p) =>
                      world.events.create(runId, data, p)
                    );

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
                      {
                        runId,
                        traceCarrier: await nextTraceCarrier(),
                        requestedAt: new Date(),
                        ...extraPayload,
                      },
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
                      // MUST be a full, cursor-less reload. The cursor filters
                      // by lexicographic event id while a hole is defined by
                      // ULID *time*: an event in the same millisecond sorts
                      // either side of the cursor depending on its random
                      // component, and an event minted in an earlier
                      // millisecond but committed later always sorts below it.
                      // An incremental load therefore heals the hole only by
                      // luck.
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

                  // If incoming message has a stepId, this is a background step
                  // execution. Execute the step, then check if all parallel steps
                  // from the batch are done. If so, replay inline (saving a queue
                  // roundtrip). If not, return — the last handler to complete
                  // will pick up the replay.
                  if (incomingStepId && incomingStepName) {
                    try {
                      const bgRun = await world.runs.get(runId, {
                        resolveData: 'none',
                      });
                      if (bgRun.status !== 'running') {
                        runtimeLogger.debug(
                          'Run already finished, skipping background step',
                          { workflowRunId: runId, status: bgRun.status }
                        );
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
                        stepResult = await runStepSingleFlight(
                          runId,
                          incomingStepId,
                          () =>
                            executeStep({
                              world,
                              workflowRunId: runId,
                              workflowDeploymentId: bgRun.deploymentId,
                              workflowName,
                              workflowStartedAt: bgStartedAt,
                              rootRunId: rootRunIdFrom(bgRun.attributes, runId),
                              stepId: incomingStepId,
                              stepName: incomingStepName,
                              runSpecVersion: bgRun.specVersion,
                              // Retry ceiling: the queue delivery count as a fast
                              // gate, verified against the recorded step_started
                              // count once it crosses the ceiling (see above).
                              authoritativeAttempt: bgAuthoritativeAttempt,
                            })
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

                  // --- Infrastructure: prepare the run state ---
                  // Skip if workflowRun was already set by the background
                  // step path (inline replay after all parallel steps done).
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

                  // Lazy hook resume: the producer (resumeHook fast path)
                  // parallelized the `hook_received` write with this queue
                  // publish, so the event may not be persisted yet. Idempotently
                  // ensure it before replay — keyed by `resumeId` so a
                  // concurrent producer write converges on exactly one event
                  // (the server resolves a matching claim as success, not an
                  // error). `hookInput` never rides a turbo first-delivery
                  // (that path carries `runInput`, not `hookInput`), so this
                  // only runs on the normal load-and-replay path.
                  if (hookInput) {
                    // Perf (Option A): if the producer's concurrent direct
                    // write already landed in the run_started preload, the
                    // canonical event is in the log and the re-ensure round trip
                    // is pure overhead. Skip it when the preload already carries
                    // a `hook_received` with this resume's persisted `resumeId`
                    // (unique per resume, so we never skip on an unrelated
                    // hook_received). Best-effort: the win lands only when the
                    // producer's write beat this consumer's load; otherwise we
                    // fall through to the idempotent re-ensure below.
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
                      });
                      // On Vercel, handleReplayBudgetExhausted always
                      // exits the process. On local dev it returns; we
                      // fall through and the request ends normally
                      // (run_failed has been written best-effort).
                      return;
                    }

                    // Check timeout before replay
                    if (
                      Date.now() - invocationStartTime >=
                      NO_INLINE_REPLAY_AFTER_MS
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
                          await createEvent(waitEvent, {
                            requestId,
                            ...preconditionSnapshotParams(
                              eventLog.events,
                              eventLog.cursor
                            ),
                          });
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

                      if (waitsToComplete.length > 0) {
                        // The event list above may be stale by the time an
                        // elapsed wait is committed. Load only events after
                        // the original snapshot cursor so concurrent durable
                        // events, such as hook_received, keep their ordering
                        // relative to wait_completed. Fall back to a full
                        // reload for older worlds that cannot give us a stable
                        // cursor, or if the cursor delta does not include the
                        // wait completion this handler just attempted.
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
                          const sawAllWaitCompletions = waitsToComplete.every(
                            (waitEvent) =>
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

                      // Workflow completed. Send the snapshot but do NOT
                      // reload-and-retry the create in place: `result` was
                      // computed by this replay, so a stale (412) rejection must
                      // force a *fresh replay* (which may observe the new event
                      // and produce a different result), not re-commit the stale
                      // result. The catch below restarts the replay in-process.
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
                          {
                            requestId,
                            ...preconditionSnapshotParams(
                              eventLog.events,
                              eventLog.cursor
                            ),
                          }
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
                        const replayDurationMs = Date.now() - replayStart;
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
                        //     queueing, a later handler queues it;
                        //     idempotencyKey on correlationId dedupes
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
                        for (const step of pendingSteps) {
                          if (inlineCorrelationIds.has(step.correlationId)) {
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
                              },
                              {
                                idempotencyKey: step.correlationId,
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
                        await Promise.all(dispatches);

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
                        }> = [
                          ...lazyInlineSteps.map((s) => ({
                            correlationId: s.correlationId,
                            stepName: s.stepName,
                            lazyStepInput: s.dehydratedInput,
                          })),
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
                        //    open wait in the cumulative log: a concurrent
                        //    `wait_completed` landing after the delta snapshot
                        //    does not bump the outside-event marker, so nothing
                        //    fences a replay from the stale delta.
                        //  - No open (or this-suspension-created) hook — UNLESS
                        //    the precondition guard is enabled AND the World
                        //    declares it actually enforces the guard
                        //    (`capabilities.preconditionGuard`; the env flag
                        //    alone only makes the runtime SEND snapshots, which
                        //    an unsupporting backend ignores — no fence). The
                        //    delta snapshots the log at the step_completed
                        //    write but is consumed on the next replay, so an
                        //    out-of-band `hook_received` landing in that window
                        //    is absent from the delta and observed one
                        //    iteration later than a real fetch would observe
                        //    it. That staleness is qualitatively the same
                        //    read-to-write race the fetch path already has (an
                        //    event can land right after `events.list` returns
                        //    and before the suspension's writes); with an
                        //    enforced guard it is also fenced: `hook_received`
                        //    bumps the per-run outside-event marker, so every
                        //    durable write the stale replay attempts is
                        //    rejected with 412 — its guarded suspension creates
                        //    (retried over the reloaded log, or exhausted into
                        //    a queue re-invocation), AND the lazy step_started
                        //    claim of its next inline step, which carries the
                        //    snapshot too (threaded below via
                        //    `stateUpdatedAt`; on rejection the batch is
                        //    abandoned and re-invoked for a fresh replay, so a
                        //    stale view can never commit a step). Hooks created
                        //    by THIS suspension are inside the delta (their
                        //    `hook_created` lands before the step-terminal
                        //    write), so only their `hook_received` responses
                        //    are subject to the same fenced window. Without an
                        //    enforced guard there is no fence, so keep the
                        //    conservative gate.
                        //  - With no hook or wait open at all, the only
                        //    out-of-band writer is cancellation, which is safe
                        //    to observe one iteration late. See
                        //    openHookAndWaitState.
                        //
                        // When more than one step runs inline, each writes its
                        // own events and the per-write delta would be partial, so
                        // the delta is not requested (the gate below is false for
                        // multi-step) and the next iteration does a normal fetch.
                        // Whether the precondition guard is actually in force:
                        // enabled by env AND enforced by the World. The env
                        // flag alone only makes the runtime send snapshots,
                        // which an unsupporting backend ignores (no fence).
                        const guardEnforced =
                          isPreconditionGuardEnabled() &&
                          world.capabilities?.preconditionGuard === true;

                        const requestInlineDelta =
                          typeof eventLog.cursor === 'string' &&
                          err.stepCount === 1 &&
                          err.waitCount === 0 &&
                          pendingSteps.length === 1 &&
                          lazyInlineSteps.length === 1 &&
                          ownedRecoverySteps.length === 0 &&
                          !suspensionResult.waitTimeout &&
                          !openHookWaitState.openWait &&
                          (guardEnforced ||
                            (err.hookCount === 0 &&
                              !openHookWaitState.openHook));

                        // Stale-sensitive batch: a hook is open in the run (or
                        // was created by this suspension, so its hook_received
                        // can land any moment) — an out-of-band event can make
                        // the view this batch was scheduled from stale. With
                        // the guard in force, the fence rejects a stale
                        // claim's durable writes — but it cannot un-run a step
                        // BODY that optimistic start began before the claim
                        // settled. Suppress optimistic start for these batches
                        // (take await-then-run) so a 412-fenced step never
                        // executes user code at all: the fence then covers
                        // side effects, not just the event log. Costs one
                        // claim round-trip per step while a hook is open, only
                        // on guard-enforcing deployments. Without the guard
                        // nothing 412s, so suppression would buy nothing —
                        // stale-view exposure there is the pre-existing
                        // optimistic-start contract (idempotent side effects).
                        const suppressOptimisticStart =
                          guardEnforced &&
                          (openHookWaitState.openHook ||
                            err.hookCount > 0 ||
                            suspensionResult.hasHookEvents);

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

                        // Precondition-guard snapshot for the inline
                        // step_started claims: the lazy claim is the first
                        // durable write of a hot-path step (its step_created
                        // is deferred), so without a snapshot it would bypass
                        // the guard entirely and a stale replay could claim —
                        // and commit — a step scheduled off a view that misses
                        // an event it never loaded.
                        // `preconditionSnapshotParams` returns an empty object
                        // when the guard env flag is off, so this is a no-op
                        // outside guarded deployments; Worlds that don't
                        // enforce the guard ignore it.
                        const inlineClaimSnapshot = preconditionSnapshotParams(
                          eventLog.events,
                          eventLog.cursor
                        );

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
                                  s.lazyStepInput !== undefined
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
                                // from the existing step entity.
                                lazyStepInput: s.lazyStepInput,
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
                                preconditionSnapshot: inlineClaimSnapshot,
                                ...(stepIndex === 0 &&
                                s.lazyStepInput !== undefined &&
                                latencyTracking
                                  ? { latencyTracking }
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
                            // Lazy steps are brand-new (their create-claim
                            // is the exactly-once gate), but an
                            // owned-recovery step already exists and its
                            // delayed backstop message may fire mid-body
                            // in this same process — route those through
                            // the in-process single-flight.
                            const executed =
                              s.lazyStepInput === undefined
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
                        try {
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
                                  // correlationId so it dedupes against the
                                  // keyed re-dispatch the suspension handler
                                  // performs on replay (it also uses
                                  // `idempotencyKey: step.correlationId`).
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
                                  idempotencyKey: step.correlationId,
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
                        // Precondition-guard asymmetry: unlike `run_completed`,
                        // this terminal `run_failed` sends no `stateUpdatedAt`
                        // snapshot, so it is never 412-rejected even if a hook
                        // landed mid-replay and could have changed the path that
                        // threw. This is intentional and fail-open: a spurious
                        // failure is recoverable (the run can be re-run from the
                        // dashboard), whereas a spurious *completion* commits a
                        // wrong result. Guarding this write symmetrically would
                        // also need the loaded event log, which is scoped to the
                        // replay `try` above and not available in this catch.
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
