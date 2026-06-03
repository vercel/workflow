import type { Span } from '@opentelemetry/api';
import { waitUntil } from '@vercel/functions';
import { HookNotFoundError, RunExpiredError } from '@workflow/errors';
import {
  type CreateEventRequest,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { importKey } from '../encryption.js';
import type {
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import { runtimeLogger } from '../logger.js';
import { dehydrateStepArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier } from '../telemetry.js';
import { queueMessage } from './helpers.js';
import { fencedEventCreate } from './fenced-write.js';

/**
 * Extracts W3C trace context headers from a trace carrier for HTTP propagation.
 * Returns an object with `traceparent` and optionally `tracestate` headers.
 */
function extractTraceHeaders(
  traceCarrier: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (traceCarrier.traceparent) {
    headers.traceparent = traceCarrier.traceparent;
  }
  if (traceCarrier.tracestate) {
    headers.tracestate = traceCarrier.tracestate;
  }
  return headers;
}

export interface SuspensionHandlerParams {
  suspension: WorkflowSuspension;
  world: World;
  run: WorkflowRun;
  span?: Span;
  requestId?: string;
  /**
   * Caller's load-time view of the event log (tail eventId), used as the OCC
   * fence on branch-decision writes (hook_created, hook_disposed, step_created,
   * wait_created). `undefined` => unfenced (server still advances the
   * materialized lastKnownEventId). See `fenced-write.ts`.
   */
  fenceEventId?: string;
}

export interface SuspensionHandlerResult {
  timeoutSeconds?: number;
}

/**
 * Handles a workflow suspension by processing all pending operations (hooks, steps, waits).
 * Uses an event-sourced architecture where entities (steps, hooks) are created atomically
 * with their corresponding events via events.create().
 *
 * Processing order:
 * 1. Hooks are processed first to prevent race conditions with webhook receivers
 * 2. Steps and waits are processed in parallel after hooks complete
 */
export async function handleSuspension({
  suspension,
  world,
  run,
  span,
  requestId,
  fenceEventId: initialFenceEventId,
}: SuspensionHandlerParams): Promise<SuspensionHandlerResult> {
  const runId = run.runId;
  const workflowName = run.workflowName;
  const workflowStartedAt = run.startedAt ? +run.startedAt : Date.now();
  // Per-suspension OCC fence. Each successful fenced branch-decision write
  // advances this so subsequent writes from this handler chain off it. The
  // server fence is a single-tip CAS; on conflict fencedEventCreate bails the
  // write (yields to the canonical replay) rather than throwing.
  let fenceEventId = initialFenceEventId;
  // Separate queue items by type
  const stepItems = suspension.steps.filter(
    (item): item is StepInvocationQueueItem => item.type === 'step'
  );
  const allHookItems = suspension.steps.filter(
    (item): item is HookInvocationQueueItem => item.type === 'hook'
  );
  const waitItems = suspension.steps.filter(
    (item): item is WaitInvocationQueueItem => item.type === 'wait'
  );

  // Split hooks by what actions they need
  const hooksNeedingCreation = allHookItems.filter(
    (item) => !item.hasCreatedEvent
  );
  // Hooks needing disposal: any disposed hook (including those needing creation first)
  // Hooks are created before disposal in the processing order below
  const hooksNeedingDisposal = allHookItems.filter((item) => item.disposed);

  // Resolve encryption key for this run
  const rawKey = await world.getEncryptionKeyForRun?.(run);
  const encryptionKey = rawKey ? await importKey(rawKey) : undefined;

  // Build hook_created events (World will atomically create hook entities)
  const hookEvents: CreateEventRequest[] = await Promise.all(
    hooksNeedingCreation.map(async (queueItem) => {
      const hookMetadata: SerializedData | undefined =
        typeof queueItem.metadata === 'undefined'
          ? undefined
          : ((await dehydrateStepArguments(
              queueItem.metadata,
              runId,
              encryptionKey,
              suspension.globalThis
            )) as SerializedData);
      return {
        eventType: 'hook_created' as const,
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: queueItem.correlationId,
        eventData: {
          token: queueItem.token,
          metadata: hookMetadata,
          isWebhook: queueItem.isWebhook ?? false,
        },
      };
    })
  );

  // Process hooks first to prevent race conditions with webhook receivers
  // All hook creations run in parallel
  // Track any hook conflicts that occur - these will be handled by re-enqueueing the workflow
  let hasHookConflict = false;

  // Sequential (not Promise.all) so each fenced write chains off the prior
  // event id — the server fence is a single-tip CAS.
  for (const hookEvent of hookEvents) {
    try {
      const writeResult = await fencedEventCreate({
        world,
        runId,
        event: hookEvent,
        requestId,
        fenceEventId,
        onEntityConflict: () => 'abort',
      });
      if (writeResult.newFenceEventId) {
        fenceEventId = writeResult.newFenceEventId;
      }
      if (!writeResult.written) {
        runtimeLogger.info(
          'Workflow run already completed or hook already created, skipping',
          { workflowRunId: runId, correlationId: hookEvent.correlationId }
        );
        continue;
      }
      // Check if the world returned a hook_conflict event instead of hook_created
      if (writeResult.event?.eventType === 'hook_conflict') {
        hasHookConflict = true;
      }
    } catch (err) {
      if (RunExpiredError.is(err)) {
        runtimeLogger.info('Workflow run already completed, skipping hook', {
          workflowRunId: runId,
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // Process hook disposals - these release hook tokens for reuse by other
  // workflows. Sequential + fenced (see hook_created above).
  for (const queueItem of hooksNeedingDisposal) {
    const hookDisposedEvent: CreateEventRequest = {
      eventType: 'hook_disposed' as const,
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: queueItem.correlationId,
      eventData: {
        token: queueItem.token,
      },
    };
    try {
      const writeResult = await fencedEventCreate({
        world,
        runId,
        event: hookDisposedEvent,
        requestId,
        fenceEventId,
        onEntityConflict: () => 'abort',
      });
      if (writeResult.newFenceEventId) {
        fenceEventId = writeResult.newFenceEventId;
      }
    } catch (err) {
      if (RunExpiredError.is(err)) {
        runtimeLogger.info(
          'Workflow run already completed, skipping hook disposal',
          {
            workflowRunId: runId,
            correlationId: queueItem.correlationId,
            message: err.message,
          }
        );
      } else if (HookNotFoundError.is(err)) {
        // Hook may have already been disposed or never created
        runtimeLogger.info('Hook not found for disposal, continuing', {
          workflowRunId: runId,
          correlationId: queueItem.correlationId,
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // Build a map of stepId -> step event for steps that need creation
  const stepsNeedingCreation = new Set(
    stepItems
      .filter((queueItem) => !queueItem.hasCreatedEvent)
      .map((queueItem) => queueItem.correlationId)
  );

  // Phase 1: create branch-decision events (step_created, wait_created)
  // SEQUENTIALLY so each fenced write chains off the prior event id (the
  // server fence is a single-tip CAS). On fence conflict, fencedEventCreate
  // bails the write — a concurrent canonical replay owns the log.
  //
  // Only steps whose step_created THIS handler actually wrote should be
  // queued for execution (single-owner), so we track those correlationIds.
  const stepsToQueue: StepInvocationQueueItem[] = [];
  for (const queueItem of stepItems) {
    if (stepsNeedingCreation.has(queueItem.correlationId)) {
      const dehydratedInput = await dehydrateStepArguments(
        {
          args: queueItem.args,
          closureVars: queueItem.closureVars,
          thisVal: queueItem.thisVal,
        },
        runId,
        encryptionKey,
        suspension.globalThis
      );
      const stepEvent: CreateEventRequest = {
        eventType: 'step_created' as const,
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: queueItem.correlationId,
        eventData: {
          stepName: queueItem.stepName,
          input: dehydratedInput as SerializedData,
        },
      };
      const writeResult = await fencedEventCreate({
        world,
        runId,
        event: stepEvent,
        requestId,
        fenceEventId,
        onEntityConflict: () => 'abort',
      });
      if (writeResult.newFenceEventId) {
        fenceEventId = writeResult.newFenceEventId;
      }
      if (!writeResult.written) {
        // Fence conflict or step already exists — a concurrent canonical
        // replay owns this step. Do not queue it from here.
        runtimeLogger.info(
          'Step create skipped (fence conflict or already exists), not queuing',
          { workflowRunId: runId, correlationId: queueItem.correlationId }
        );
        continue;
      }
      stepsToQueue.push(queueItem);
    } else {
      // step_created already existed before this handler ran — still queue
      // (matches prior behavior of always queuing every stepItem).
      stepsToQueue.push(queueItem);
    }
  }

  for (const queueItem of waitItems) {
    if (!queueItem.hasCreatedEvent) {
      const waitEvent: CreateEventRequest = {
        eventType: 'wait_created' as const,
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: queueItem.correlationId,
        eventData: {
          resumeAt: queueItem.resumeAt,
        },
      };
      const writeResult = await fencedEventCreate({
        world,
        runId,
        event: waitEvent,
        requestId,
        fenceEventId,
        onEntityConflict: () => 'abort',
      });
      if (writeResult.newFenceEventId) {
        fenceEventId = writeResult.newFenceEventId;
      }
      if (!writeResult.written) {
        runtimeLogger.info(
          'Wait create skipped (fence conflict or already exists)',
          { workflowRunId: runId, correlationId: queueItem.correlationId }
        );
      }
    }
  }

  // Phase 2: queue step execution messages in parallel (no fence interaction).
  const ops: Promise<void>[] = [];
  for (const queueItem of stepsToQueue) {
    ops.push(
      (async () => {
        // Serialize trace context once and include in both payload and headers
        const traceCarrier = await serializeTraceCarrier();
        await queueMessage(
          world,
          `__wkf_step_${queueItem.stepName}`,
          {
            workflowName,
            workflowRunId: runId,
            workflowStartedAt,
            stepId: queueItem.correlationId,
            traceCarrier,
            requestedAt: new Date(),
          },
          {
            idempotencyKey: queueItem.correlationId,
            headers: {
              ...extractTraceHeaders(traceCarrier),
            },
          }
        );
      })()
    );
  }

  // Wait for all step and wait operations to complete
  waitUntil(
    Promise.all(ops).catch((opErr) => {
      const isAbortError =
        opErr?.name === 'AbortError' || opErr?.name === 'ResponseAborted';
      if (!isAbortError) throw opErr;
    })
  );
  await Promise.all(ops);

  // Calculate minimum timeout from waits
  const now = Date.now();
  const minTimeoutSeconds = waitItems.reduce<number | null>(
    (min, queueItem) => {
      const resumeAtMs = queueItem.resumeAt.getTime();
      const delayMs = Math.max(1000, resumeAtMs - now);
      const timeoutSeconds = Math.ceil(delayMs / 1000);
      if (min === null) return timeoutSeconds;
      return Math.min(min, timeoutSeconds);
    },
    null
  );

  span?.setAttributes({
    ...Attribute.WorkflowRunStatus('workflow_suspended'),
    ...Attribute.WorkflowStepsCreated(stepItems.length),
    ...Attribute.WorkflowHooksCreated(hooksNeedingCreation.length),
    ...Attribute.WorkflowWaitsCreated(waitItems.length),
  });

  // If any hook conflicts occurred, re-enqueue the workflow immediately
  // On the next iteration, the hook consumer will see the hook_conflict event
  // and reject the promise with a WorkflowRuntimeError
  // We do this after processing all other operations (steps, waits) to ensure
  // they are recorded in the event log before the re-execution
  if (hasHookConflict) {
    return { timeoutSeconds: 0 };
  }

  if (minTimeoutSeconds !== null) {
    return { timeoutSeconds: minTimeoutSeconds };
  }

  return {};
}
