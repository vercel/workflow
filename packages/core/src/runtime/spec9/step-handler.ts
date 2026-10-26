import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  SerializedData,
  WorkflowInvokePayload,
  WorkflowRun,
  World,
} from '@workflow/world';
import { runtimeLogger } from '../../logger.js';
import { getStepFunction } from '../../private.js';
import * as Attribute from '../../telemetry/semantic-conventions.js';
import { DEFAULT_STEP_MAX_RETRIES } from '../constants.js';
import {
  getWorkflowQueueName,
  loadWorkflowRunEvents,
  memoizeEncryptionKey,
  queueMessage,
  rootRunIdFrom,
} from '../helpers.js';
import type { ResumeTtrTracking } from '../resume-latency.js';
import { stepCreationOf } from './log-state.js';
import {
  decideStepDelivery,
  firstDeliveryDecision,
  type StepDeliveryDecision,
  stepDeliveryNeedsLogRead,
} from './step-delivery.js';
import { executeStep, failStepForExhaustedRetries } from './step-executor.js';
import {
  retryOutlivesMessage,
  stepMessageRetentionSeconds,
} from './step-retention.js';
import { runStepSingleFlight } from './step-single-flight.js';

type Span = { setAttributes(attributes: Record<string, unknown>): void };

export interface StepMessageContext {
  world: World;
  runId: string;
  workflowName: string;
  namespace: string | undefined;
  requestId: string | undefined;
  payload: Pick<
    WorkflowInvokePayload,
    | 'stepId'
    | 'stepName'
    | 'stepAttempt'
    | 'stepInput'
    | 'stepCreatedEventId'
    | 'runContext'
  > & { stepId: string; stepName: string };
  /** The run, when routing the delivery already read it. */
  prefetchedRun?: WorkflowRun;
  meta: {
    deliveryCount?: number;
    createdAt?: Date;
    messageId: string;
  };
  resumeTracking: ResumeTtrTracking | undefined;
  span: Span | undefined;
  nextTraceCarrier: () => Promise<Record<string, string>>;
  /**
   * The deployment-affinity guard of the orchestrator handler. Returns false
   * when the delivery was re-routed or refused and must end here.
   */
  guardDeployment: (run: {
    runId: string;
    deploymentId: string;
    specVersion: number;
  }) => Promise<boolean>;
}

/**
 * Handles one delivery of a background step's queue message.
 *
 * The step invocation never replays the workflow and never continues the
 * run. It:
 *
 * 1. decides from the delivery (and, on any delivery but a plain first one,
 *    from the run's full log) whether to run the body, using the table in
 *    `orchestrator/step-delivery.ts`;
 * 2. writes `step_started`, runs the body, and writes the outcome, all
 *    out-of-band (`inBand: false`). On a plain first delivery a step that
 *    allows retries starts its body while `step_started` is in flight, and
 *    its outcome is written only once that start committed;
 * 3. wakes the run's orchestrator with an unkeyed message.
 *
 * Its result is queue control, per the World's `createQueueHandler`
 * contract: `undefined` acknowledges the message, `{ timeoutSeconds }`
 * delivers the same message again after the delay. The message is
 * acknowledged only once a terminal step event or a terminal run is
 * committed, so a retry stays on this message until the step ends.
 */
export async function handleStepMessage(
  ctx: StepMessageContext
): Promise<{ timeoutSeconds: number } | undefined> {
  const { world, runId, workflowName, payload, meta, span } = ctx;
  const { stepId, stepName } = payload;

  const runIdentity = await resolveRunIdentity(ctx);
  if (runIdentity === 'terminal') return undefined;
  // Every wake names the run's spec version itself (see `wakeOrchestrator`).
  const wakeCtx = { ...ctx, specVersion: runIdentity.specVersion };
  span?.setAttributes(
    Attribute.StepDispatchPrologue(
      payload.runContext ? 'run_context' : 'runs_get'
    )
  );
  if (
    !(await ctx.guardDeployment({
      runId,
      deploymentId: runIdentity.deploymentId,
      specVersion: runIdentity.specVersion,
    }))
  ) {
    return undefined;
  }

  const maxRetries =
    getStepFunction(stepName)?.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;

  let log: Event[] | undefined;
  let decision: StepDeliveryDecision;
  if (
    stepDeliveryNeedsLogRead({
      deliveryCount: meta.deliveryCount,
      stepAttempt: payload.stepAttempt,
    })
  ) {
    log = (await loadWorkflowRunEvents(runId)).events;
    decision = decideStepDelivery({
      events: log,
      stepId,
      maxRetries,
      nowMs: Date.now(),
    });
  } else {
    decision = firstDeliveryDecision(payload.stepAttempt);
  }
  // On the span whatever the decision: the `run` path sets the step's
  // attributes again inside `executeStep`, the others leave only these.
  span?.setAttributes({
    ...Attribute.StepId(stepId),
    ...Attribute.StepName(stepName),
    ...Attribute.StepDeliveryDecision(decision.action),
    ...('reason' in decision
      ? Attribute.StepDeliveryReason(decision.reason)
      : {}),
    ...(decision.action === 'redeliver'
      ? Attribute.StepDeliveryTimeoutSeconds(decision.timeoutSeconds)
      : {}),
  });
  runtimeLogger.debug('Step delivery decision', {
    workflowRunId: runId,
    stepId,
    deliveryCount: meta.deliveryCount,
    decision: decision.action,
    ...('reason' in decision ? { reason: decision.reason } : {}),
  });

  const createEvent = <T extends CreateEventRequest>(
    data: T,
    params?: CreateEventParams
  ) =>
    world.events.create(runId, data, {
      ...params,
      inBand: false,
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    });
  const getEncryptionKey = memoizeEncryptionKey(world, runId);

  switch (decision.action) {
    case 'ack':
      // The step's outcome is in the log, but the delivery that wrote it may
      // have died, or failed to send its wake, before the orchestrator heard
      // of it: that wake is the only thing that moves the run on, and nothing
      // else re-sends it. Send it again. It is cheap: a live orchestrator
      // absorbs it, and one with nothing new acknowledges it after a tail
      // read. A finished run needs no wake.
      if (decision.reason === 'step-terminal') await wakeOrchestrator(wakeCtx);
      return undefined;
    case 'redeliver':
      return { timeoutSeconds: decision.timeoutSeconds };
    case 'fail': {
      const failed = await failStepForExhaustedRetries({
        createEvent,
        workflowRunId: runId,
        stepId,
        stepName,
        attempt: decision.attempt,
        maxRetries,
        encryptionKey: await getEncryptionKey(),
        runSpecVersion: runIdentity.specVersion,
      });
      if (failed.type !== 'gone') await wakeOrchestrator(wakeCtx);
      return undefined;
    }
    case 'run':
      break;
  }

  const input = await resolveStepInput(ctx, log);
  const retentionSeconds = stepMessageRetentionSeconds(maxRetries);
  const result = await runStepSingleFlight(runId, stepId, () =>
    executeStep({
      world,
      createEvent,
      workflowRunId: runId,
      workflowDeploymentId: runIdentity.deploymentId,
      workflowName,
      workflowStartedAt: runIdentity.startedAt ?? Date.now(),
      rootRunId: runIdentity.rootRunId ?? runId,
      requestId: ctx.requestId,
      stepId,
      stepName,
      runSpecVersion: runIdentity.specVersion,
      attempt: decision.attempt,
      ...(decision.firstStartedAt
        ? { firstStartedAt: decision.firstStartedAt }
        : {}),
      input,
      // A plain first delivery (no log read) starts the body while its
      // `step_started` is in flight, for a step that allows retries (see
      // `mayRunBeforeItsStart`); the outcome waits for the start, and a
      // start that did not commit discards it. A redelivery, a retry's
      // message and a `maxRetries: 0` step write the start first.
      forceOptimisticStart: log === undefined,
      retryOutlivesMessage: (retryAtMs) =>
        retryOutlivesMessage({
          messageCreatedAt: meta.createdAt,
          retentionSeconds,
          retryAtMs,
        }),
      ...(ctx.resumeTracking ? { resumeTracking: ctx.resumeTracking } : {}),
    })
  );

  switch (result.type) {
    case 'gone':
      return undefined;
    case 'throttled':
      return { timeoutSeconds: result.timeoutSeconds };
    case 'retry':
      await wakeOrchestrator(wakeCtx);
      return { timeoutSeconds: result.timeoutSeconds };
    case 'completed':
    case 'failed':
      await wakeOrchestrator(wakeCtx);
      return undefined;
  }
}

/**
 * Wakes the run's orchestrator after an out-of-band write. No idempotency
 * key: a key could be absorbed by a delivery that is already exiting and lose
 * the wakeup, while a duplicate wake only costs a cheap delivery.
 *
 * A background step's outcome wakes it this way too, without reading the
 * run's log first: the orchestrator decides from its own load what the
 * outcome lets the run do. A fan-out's completions then send one wake each,
 * which a World that coalesces an orchestrator's messages folds into the
 * delivery that holds the run, and which a delivery that finds nothing new
 * since its last consumed position acknowledges without a replay (see
 * `consumed-position.ts`).
 *
 * `specVersion` is the run's: the wake carries it, so a World that reads the
 * run's spec off the payload (world-vercel keys and continues spec 9 runs'
 * messages differently) never has to guess. Without it the wake carries only
 * what this process remembers about the run (`withRunSpecVersion`).
 */
export async function wakeOrchestrator(ctx: {
  world: World;
  runId: string;
  workflowName: string;
  namespace: string | undefined;
  nextTraceCarrier: () => Promise<Record<string, string>>;
  specVersion?: number;
}): Promise<void> {
  await queueMessage(
    ctx.world,
    getWorkflowQueueName(ctx.workflowName, ctx.namespace),
    {
      runId: ctx.runId,
      traceCarrier: await ctx.nextTraceCarrier(),
      requestedAt: new Date(),
    },
    ctx.specVersion !== undefined ? { specVersion: ctx.specVersion } : undefined
  );
}

type RunIdentity = {
  deploymentId: string;
  specVersion: number;
  startedAt?: number;
  rootRunId?: string;
};

async function resolveRunIdentity(
  ctx: StepMessageContext
): Promise<RunIdentity | 'terminal'> {
  if (ctx.payload.runContext) return ctx.payload.runContext;
  const run =
    ctx.prefetchedRun ??
    ((await ctx.world.runs.get(ctx.runId, {
      resolveData: 'none',
    })) as WorkflowRun);
  if (run.status !== 'running') {
    runtimeLogger.debug('Run already finished, skipping background step', {
      workflowRunId: ctx.runId,
      status: run.status,
    });
    return 'terminal';
  }
  return {
    deploymentId: run.deploymentId,
    specVersion: run.specVersion ?? 0,
    ...(run.startedAt ? { startedAt: +run.startedAt } : {}),
    rootRunId: rootRunIdFrom(run.attributes, ctx.runId),
  };
}

/**
 * The step's serialized input: carried on the message when it is small,
 * otherwise read from the step's `step_created` event.
 */
async function resolveStepInput(
  ctx: StepMessageContext,
  log: Event[] | undefined
): Promise<SerializedData> {
  if (ctx.payload.stepInput) return ctx.payload.stepInput.input;
  let eventId = ctx.payload.stepCreatedEventId;
  if (eventId === undefined) {
    const events = log ?? (await loadWorkflowRunEvents(ctx.runId)).events;
    eventId = events.find(
      (event) =>
        event.correlationId === ctx.payload.stepId &&
        stepCreationOf(event) !== undefined
    )?.eventId;
  }
  if (eventId === undefined) {
    throw new Error(
      `Step "${ctx.payload.stepId}" of run "${ctx.runId}" has no creation event`
    );
  }
  const created = await ctx.world.events.get(ctx.runId, eventId, {
    resolveData: 'all',
  });
  // An inline step's creation may be its first `step_started`, which then
  // carries the input.
  const input =
    created.eventType === 'step_created' ||
    (created.eventType === 'step_started' &&
      stepCreationOf(created) !== undefined)
      ? created.eventData?.input
      : undefined;
  if (input === undefined) {
    throw new Error(
      `Event "${eventId}" of run "${ctx.runId}" is not the creation of "${ctx.payload.stepId}"`
    );
  }
  return input;
}
