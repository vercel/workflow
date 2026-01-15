import type { Span } from '@opentelemetry/api';
import { waitUntil } from '@vercel/functions';
import { WorkflowAPIError } from '@workflow/errors';
import type { CreateEventRequest, World } from '@workflow/world';
import type {
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import type { Serializable } from '../schemas.js';
import { dehydrateStepArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier } from '../telemetry.js';
import { queueMessage } from './helpers.js';

export interface SuspensionHandlerParams {
  suspension: WorkflowSuspension;
  world: World;
  runId: string;
  workflowName: string;
  workflowStartedAt: number;
  span?: Span;
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
  runId,
  workflowName,
  workflowStartedAt,
  span,
}: SuspensionHandlerParams): Promise<SuspensionHandlerResult> {
  // Separate queue items by type
  const stepItems = suspension.steps.filter(
    (item): item is StepInvocationQueueItem => item.type === 'step'
  );
  const hookItems = suspension.steps.filter(
    (item): item is HookInvocationQueueItem => item.type === 'hook'
  );
  const waitItems = suspension.steps.filter(
    (item): item is WaitInvocationQueueItem => item.type === 'wait'
  );

  // Build hook_created events (World will atomically create hook entities)
  const hookEvents: CreateEventRequest[] = hookItems.map((queueItem) => {
    const hookMetadata =
      typeof queueItem.metadata === 'undefined'
        ? undefined
        : dehydrateStepArguments(queueItem.metadata, suspension.globalThis);
    return {
      eventType: 'hook_created' as const,
      correlationId: queueItem.correlationId,
      eventData: {
        token: queueItem.token,
        metadata: hookMetadata,
      },
    };
  });

  // Process hooks first to prevent race conditions with webhook receivers
  // All hook creations run in parallel
  // Track any hook conflicts that occur - these will be handled by re-enqueueing the workflow
  let hasHookConflict = false;

  if (hookEvents.length > 0) {
    await Promise.all(
      hookEvents.map(async (hookEvent) => {
        try {
          const result = await world.events.create(runId, hookEvent);
          // Check if the world returned a hook_conflict event instead of hook_created
          // The hook_conflict event is stored in the event log and will be replayed
          // on the next workflow invocation, causing the hook's promise to reject
          // Note: hook events always create an event (legacy runs throw, not return undefined)
          if (result.event!.eventType === 'hook_conflict') {
            hasHookConflict = true;
          }
        } catch (err) {
          if (WorkflowAPIError.is(err)) {
            if (err.status === 410) {
              console.warn(
                `Workflow run "${runId}" has already completed, skipping hook: ${err.message}`
              );
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      })
    );
  }

  // Build a map of stepId -> step event for steps that need creation
  const stepsNeedingCreation = new Set(
    stepItems
      .filter((queueItem) => !queueItem.hasCreatedEvent)
      .map((queueItem) => queueItem.correlationId)
  );

  // Process steps and waits in parallel
  // Each step: create event (if needed) -> queue message
  // Each wait: create event (if needed)
  const ops: Promise<void>[] = [];

  // Steps: create event then queue message, all in parallel
  for (const queueItem of stepItems) {
    ops.push(
      (async () => {
        // Create step event if not already created
        if (stepsNeedingCreation.has(queueItem.correlationId)) {
          const dehydratedInput = dehydrateStepArguments(
            {
              args: queueItem.args,
              closureVars: queueItem.closureVars,
              thisVal: queueItem.thisVal,
            },
            suspension.globalThis
          );
          const stepEvent: CreateEventRequest = {
            eventType: 'step_created' as const,
            correlationId: queueItem.correlationId,
            eventData: {
              stepName: queueItem.stepName,
              input: dehydratedInput as Serializable,
            },
          };
          try {
            await world.events.create(runId, stepEvent);
          } catch (err) {
            if (WorkflowAPIError.is(err) && err.status === 409) {
              console.warn(`Step already exists, continuing: ${err.message}`);
            } else {
              throw err;
            }
          }
        }

        // Queue step execution message
        await queueMessage(
          world,
          `__wkf_step_${queueItem.stepName}`,
          {
            workflowName,
            workflowRunId: runId,
            workflowStartedAt,
            stepId: queueItem.correlationId,
            traceCarrier: await serializeTraceCarrier(),
            requestedAt: new Date(),
          },
          {
            idempotencyKey: queueItem.correlationId,
          }
        );
      })()
    );
  }

  // Waits: create events in parallel (no queueing needed for waits)
  for (const queueItem of waitItems) {
    if (!queueItem.hasCreatedEvent) {
      ops.push(
        (async () => {
          const waitEvent: CreateEventRequest = {
            eventType: 'wait_created' as const,
            correlationId: queueItem.correlationId,
            eventData: {
              resumeAt: queueItem.resumeAt,
            },
          };
          try {
            await world.events.create(runId, waitEvent);
          } catch (err) {
            if (WorkflowAPIError.is(err) && err.status === 409) {
              console.warn(`Wait already exists, continuing: ${err.message}`);
            } else {
              throw err;
            }
          }
        })()
      );
    }
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
    ...Attribute.WorkflowHooksCreated(hookItems.length),
    ...Attribute.WorkflowWaitsCreated(waitItems.length),
  });

  // If any hook conflicts occurred, re-enqueue the workflow immediately
  // On the next iteration, the hook consumer will see the hook_conflict event
  // and reject the promise with a WorkflowRuntimeError
  // We do this after processing all other operations (steps, waits) to ensure
  // they are recorded in the event log before the re-execution
  if (hasHookConflict) {
    return { timeoutSeconds: 1 };
  }

  if (minTimeoutSeconds !== null) {
    return { timeoutSeconds: minTimeoutSeconds };
  }

  return {};
}
