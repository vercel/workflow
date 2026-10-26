import {
  EntityConflictError,
  FatalError,
  RUN_ERROR_CODES,
  RunExpiredError,
} from '@workflow/errors';
import { setWorkflowBasePath } from '@workflow/utils';
import { workflowDisplayName } from '@workflow/utils/parse-name';
import {
  type Event,
  getQueueTopicPrefix,
  type RunInput,
  resolveQueueNamespace,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { isRetryableWorldError } from './classify-error.js';
import { describeError } from './describe-error.js';
import { type Logger, runtimeLogger } from './logger.js';
import { COMPUTE_INSTANCE_ID } from './runtime/compute-instance.js';
import { getMaxQueueDeliveries } from './runtime/constants.js';
import type { Orchestrator } from './runtime/delivery.js';
import {
  getQueueOverhead,
  handleHealthCheckMessage,
  memoizeEncryptionKey,
  parseHealthCheckPayload,
  withHealthCheck,
} from './runtime/helpers.js';
import { withRunInputs } from './runtime/invocations.js';
import { dispatchRunFailedHooks } from './runtime/lifecycle-hooks.js';
import { ReplayBudget } from './runtime/replay-budget.js';
import { resumeTrackingFromMessage } from './runtime/resume-latency.js';
import { resolveRunSpec } from './runtime/run-spec-routing.js';
import { spec8Orchestrator } from './runtime/spec8/delivery.js';
import { spec9Orchestrator } from './runtime/spec9/delivery.js';

import { getWorld } from './runtime/world.js';

import { dehydrateRunError, type PayloadKey } from './serialization.js';

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

export type { Event, WorkflowRun };

/** The orchestrator that drives a run of `specVersion` (see `runtime/delivery.ts`). */
function orchestratorForSpecVersion(specVersion: number): Orchestrator {
  return specVersion >= SPEC_VERSION_SINGLE_ORCHESTRATOR
    ? spec9Orchestrator
    : spec8Orchestrator;
}

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
      withRunInputs(worldHandlers)(async (message_, metadata, activity) => {
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

        const message = WorkflowInvokePayloadSchema.parse(message_);
        const {
          runId,
          traceCarrier: incomingTraceCarrier,
          requestedAt,
          stepId: incomingStepId,
          runInput,
          hookResumeTiming,
        } = message;

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

        // The orchestrator of the run's spec version: a run keeps the one it
        // was created with (see `runtime/delivery.ts`).
        const runSpec = await resolveRunSpec(message);
        const orchestrator = orchestratorForSpecVersion(runSpec.specVersion);

        const maxQueueDeliveries = getMaxQueueDeliveries();
        if (
          metadata.attempt > maxQueueDeliveries &&
          orchestrator.countsTowardMaxDeliveries(message)
        ) {
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
            const written = await orchestrator.writeMaxDeliveriesFailure(
              world,
              runId,
              {
                error: dehydratedError,
                errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
              },
              requestId
            );
            if (written === 'superseded') {
              // Another orchestrator invocation is writing this run, so it
              // is not stuck; leave the run to it and consume this message.
              runLogger.info(
                'Max-deliveries failure superseded by a live orchestrator; acknowledging',
                { attempt: metadata.attempt }
              );
              return;
            }
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
                    // Which orchestrator handles the delivery, and how the
                    // queue counts it: a coalesced re-run or a handoff
                    // keeps `attempt` and advances `deliveryCount`.
                    ...Attribute.WorkflowRunSpecVersion(runSpec.specVersion),
                    ...Attribute.WorkflowDeliveryAttempt(metadata.attempt),
                    ...(metadata.deliveryCount !== undefined
                      ? Attribute.WorkflowDeliveryCount(metadata.deliveryCount)
                      : {}),
                  });
                  return orchestrator.runDelivery({
                    message,
                    metadata,
                    activity,
                    workflowCode,
                    namespace,
                    world,
                    span,
                    runLogger,
                    workflowName,
                    requestId,
                    resumeTracking,
                    nextTraceCarrier,
                    replayBudget,
                    prefetchedRun: runSpec.run,
                    runSpecVersion: runSpec.specVersion,
                  });
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
