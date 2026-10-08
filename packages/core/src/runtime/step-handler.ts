import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  SerializedData,
  WorkflowInvokePayload,
  WorkflowRun,
  World,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { getStepFunction } from '../private.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import {
  getWorkflowQueueName,
  loadWorkflowRunEvents,
  memoizeEncryptionKey,
  queueMessage,
  rootRunIdFrom,
} from './helpers.js';
import {
  decideStepDelivery,
  firstDeliveryDecision,
  type StepDeliveryDecision,
  stepDeliveryNeedsLogRead,
} from './orchestrator/step-delivery.js';
import {
  retryOutlivesMessage,
  stepMessageRetentionSeconds,
} from './orchestrator/step-retention.js';
import type { ResumeTtrTracking } from './resume-latency.js';
import {
  DEFAULT_STEP_MAX_RETRIES,
  executeStep,
  failStepForExhaustedRetries,
} from './step-executor.js';
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
 *    out-of-band (`inBand: false`);
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
  runtimeLogger.debug('Step delivery decision', {
    workflowRunId: runId,
    stepId,
    deliveryCount: meta.deliveryCount,
    decision: decision.action,
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
      if (failed.type !== 'gone') await wakeOrchestrator(ctx);
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
      startReason: decision.startReason,
      ...(decision.firstStartedAt
        ? { firstStartedAt: decision.firstStartedAt }
        : {}),
      input,
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
      await wakeOrchestrator(ctx);
      return { timeoutSeconds: result.timeoutSeconds };
    case 'completed':
      await wakeAfterCompletion(ctx, stepId);
      return undefined;
    case 'failed':
      // A failed step can fail the run whatever else is pending: wake now.
      await wakeOrchestrator(ctx);
      return undefined;
  }
}

/** Width of the time window whose step completions share one wake. */
export const WAKE_COALESCE_WINDOW_MS = 1000;
/**
 * Seconds a shared wake waits past the end of its window, so it is delivered
 * after every completion of the window committed, clock skew between the
 * completing invocations included.
 */
export const WAKE_COALESCE_MARGIN_SECONDS = 1;

/**
 * Wakes the run's orchestrator after a background step completed.
 *
 * A fan-out's branches complete together, and the run can usually go on only
 * once the last of them has, so one wake per completion mostly wakes the
 * orchestrator to find nothing it can do. Instead:
 *
 * - A completion that leaves no other step of the run pending (the last one
 *   of a fan-out, or a lone step) wakes the orchestrator now, unkeyed, as
 *   {@link wakeOrchestrator} does.
 * - A completion that leaves another step pending sends a wake shared by
 *   every completion of its {@link WAKE_COALESCE_WINDOW_MS} window: keyed on
 *   the window, and delayed until {@link WAKE_COALESCE_MARGIN_SECONDS} past
 *   its end. It covers what the pending steps' own completions do not, such
 *   as a `Promise.race` that this outcome already decides.
 *
 * The shared wake can never absorb a completion its delivery would not see.
 * Every completion that joins the window's key sent its wake during the
 * window, after its outcome committed, and the key's message is delivered
 * only after the window ended (the delay). So that delivery loads a log with
 * every outcome that joined it. A World that replaces a keyed message
 * instead of keeping the first keeps that bound too: every sender of the
 * window delays to the same end.
 *
 * Two last completions that each see the other pending both send the shared
 * wake: their progress waits for it, at most the window plus the margin. A
 * log that cannot be read wakes now.
 */
export async function wakeAfterCompletion(
  ctx: Parameters<typeof wakeOrchestrator>[0],
  stepId: string,
  nowMs: () => number = Date.now
): Promise<void> {
  let othersPending: boolean;
  try {
    const { events } = await loadWorkflowRunEvents(ctx.runId);
    othersPending = hasOtherPendingStep(events, stepId);
  } catch (error) {
    runtimeLogger.debug('Could not read the log after a step completed', {
      workflowRunId: ctx.runId,
      stepId,
      error: error instanceof Error ? error.message : String(error),
    });
    othersPending = false;
  }
  if (!othersPending) {
    await wakeOrchestrator(ctx);
    return;
  }
  const now = nowMs();
  const window = Math.floor(now / WAKE_COALESCE_WINDOW_MS);
  const windowEndMs = (window + 1) * WAKE_COALESCE_WINDOW_MS;
  await queueMessage(
    ctx.world,
    getWorkflowQueueName(ctx.workflowName, ctx.namespace),
    {
      runId: ctx.runId,
      traceCarrier: await ctx.nextTraceCarrier(),
      requestedAt: new Date(),
    },
    {
      idempotencyKey: `wake:${ctx.runId}:${window}`,
      delaySeconds:
        Math.ceil((windowEndMs - now) / 1000) + WAKE_COALESCE_MARGIN_SECONDS,
    }
  );
}

/** Whether a step other than `stepId` has a `step_created` and no outcome. */
export function hasOtherPendingStep(
  events: readonly Event[],
  stepId: string
): boolean {
  const pending = new Set<string>();
  for (const event of events) {
    const id = event.correlationId;
    if (!id || id === stepId) continue;
    if (event.eventType === 'step_created') pending.add(id);
    else if (
      event.eventType === 'step_completed' ||
      event.eventType === 'step_failed'
    ) {
      pending.delete(id);
    }
  }
  return pending.size > 0;
}

/**
 * Wakes the run's orchestrator after an out-of-band write. No idempotency
 * key: a key could be absorbed by a delivery that is already exiting and lose
 * the wakeup, while a duplicate wake only costs a cheap delivery.
 */
export async function wakeOrchestrator(ctx: {
  world: World;
  runId: string;
  workflowName: string;
  namespace: string | undefined;
  nextTraceCarrier: () => Promise<Record<string, string>>;
}): Promise<void> {
  await queueMessage(
    ctx.world,
    getWorkflowQueueName(ctx.workflowName, ctx.namespace),
    {
      runId: ctx.runId,
      traceCarrier: await ctx.nextTraceCarrier(),
      requestedAt: new Date(),
    }
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
  const run = (await ctx.world.runs.get(ctx.runId, {
    resolveData: 'none',
  })) as WorkflowRun;
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
        event.eventType === 'step_created' &&
        event.correlationId === ctx.payload.stepId
    )?.eventId;
  }
  if (eventId === undefined) {
    throw new Error(
      `Step "${ctx.payload.stepId}" of run "${ctx.runId}" has no step_created event`
    );
  }
  const created = await ctx.world.events.get(ctx.runId, eventId, {
    resolveData: 'all',
  });
  if (created.eventType !== 'step_created') {
    throw new Error(
      `Event "${eventId}" of run "${ctx.runId}" is not the step_created of "${ctx.payload.stepId}"`
    );
  }
  return created.eventData.input;
}
