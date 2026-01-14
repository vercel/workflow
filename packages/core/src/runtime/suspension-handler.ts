import type { Span } from '@opentelemetry/api';
import { WorkflowAPIError } from '@workflow/errors';
import type { World } from '@workflow/world';
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

interface ProcessHookParams {
  queueItem: HookInvocationQueueItem;
  world: World;
  runId: string;
  global: typeof globalThis;
}

/**
 * Processes a single hook by creating it in the database and event log.
 */
async function processHook({
  queueItem,
  world,
  runId,
  global,
}: ProcessHookParams): Promise<void> {
  try {
    // Create hook in database
    const hookMetadata =
      typeof queueItem.metadata === 'undefined'
        ? undefined
        : dehydrateStepArguments(queueItem.metadata, global);
    await world.hooks.create(runId, {
      hookId: queueItem.correlationId,
      token: queueItem.token,
      metadata: hookMetadata,
    });

    // Create hook_created event in event log
    await world.events.create(runId, {
      eventType: 'hook_created',
      correlationId: queueItem.correlationId,
    });
  } catch (err) {
    if (WorkflowAPIError.is(err)) {
      if (err.status === 409) {
        // Hook already exists (duplicate hook_id constraint), so we can skip it
        console.warn(
          `Hook with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`
        );
        return;
      } else if (err.status === 410) {
        // Workflow has already completed, so no-op
        console.warn(
          `Workflow run "${runId}" has already completed, skipping hook "${queueItem.correlationId}": ${err.message}`
        );
        return;
      }
    }
    throw err;
  }
}

interface ProcessStepParams {
  queueItem: StepInvocationQueueItem;
  world: World;
  runId: string;
  workflowName: string;
  workflowStartedAt: number;
  global: typeof globalThis;
}

/**
 * Processes a single step by creating it in the database and queueing execution.
 *
 * IMPORTANT: The queue write MUST always happen, even if the step already exists.
 * This handles the case where:
 *   1. Step is written to workflow database
 *   2. Process crashes, times out, or fails before queue write completes
 *   3. Upstream retry occurs
 *   4. Step already exists in database (409 conflict)
 *
 * If we skipped the queue write on 409, the step would sit "pending" forever
 * with 0 attempts. The queue write uses an idempotency key (correlation ID),
 * so duplicate queue writes are safely deduplicated by the queue service.
 */
async function processStep({
  queueItem,
  world,
  runId,
  workflowName,
  workflowStartedAt,
  global,
}: ProcessStepParams): Promise<void> {
  const dehydratedInput = dehydrateStepArguments(
    {
      args: queueItem.args,
      closureVars: queueItem.closureVars,
      thisVal: queueItem.thisVal,
    },
    global
  );

  // The stepId to use for the queue message. This will be the correlation ID
  // regardless of whether we created a new step or the step already existed.
  const stepId = queueItem.correlationId;

  try {
    await world.steps.create(runId, {
      stepId: queueItem.correlationId,
      stepName: queueItem.stepName,
      input: dehydratedInput as Serializable,
    });
  } catch (err) {
    if (WorkflowAPIError.is(err) && err.status === 409) {
      // Step already exists - this is expected on retries. We still need to
      // proceed with the queue write below to ensure the step gets executed.
      // See function comment above for details on why this is critical.
      console.warn(
        `Step "${queueItem.stepName}" with correlation ID "${queueItem.correlationId}" already exists, proceeding with queue write`
      );
    } else {
      throw err;
    }
  }

  // Always write to queue, even if step already existed. The idempotency key
  // ensures duplicate queue writes are safely deduplicated by the queue service.
  await queueMessage(
    world,
    `__wkf_step_${queueItem.stepName}`,
    {
      workflowName,
      workflowRunId: runId,
      workflowStartedAt,
      stepId,
      traceCarrier: await serializeTraceCarrier(),
      requestedAt: new Date(),
    },
    {
      idempotencyKey: queueItem.correlationId,
    }
  );
}

interface ProcessWaitParams {
  queueItem: WaitInvocationQueueItem;
  world: World;
  runId: string;
}

/**
 * Processes a single wait by creating the event and calculating timeout.
 * @returns The timeout in seconds, or null if the wait already exists.
 */
async function processWait({
  queueItem,
  world,
  runId,
}: ProcessWaitParams): Promise<number | null> {
  try {
    // Only create wait_created event if it hasn't been created yet
    if (!queueItem.hasCreatedEvent) {
      await world.events.create(runId, {
        eventType: 'wait_created',
        correlationId: queueItem.correlationId,
        eventData: {
          resumeAt: queueItem.resumeAt,
        },
      });
    }

    // Calculate how long to wait before resuming
    const now = Date.now();
    const resumeAtMs = queueItem.resumeAt.getTime();
    const delayMs = Math.max(1000, resumeAtMs - now);
    return Math.ceil(delayMs / 1000);
  } catch (err) {
    if (WorkflowAPIError.is(err) && err.status === 409) {
      // Wait already exists, so we can skip it
      console.warn(
        `Wait with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`
      );
      return null;
    }
    throw err;
  }
}

/**
 * Handles a workflow suspension by processing all pending operations (hooks, steps, waits).
 * Hooks are processed first to prevent race conditions, then steps and waits in parallel.
 */
export async function handleSuspension({
  suspension,
  world,
  runId,
  workflowName,
  workflowStartedAt,
  span,
}: SuspensionHandlerParams): Promise<SuspensionHandlerResult> {
  // Separate queue items by type for parallel processing
  const stepItems = suspension.steps.filter(
    (item): item is StepInvocationQueueItem => item.type === 'step'
  );
  const hookItems = suspension.steps.filter(
    (item): item is HookInvocationQueueItem => item.type === 'hook'
  );
  const waitItems = suspension.steps.filter(
    (item): item is WaitInvocationQueueItem => item.type === 'wait'
  );

  // Process all hooks first to prevent race conditions
  await Promise.all(
    hookItems.map((queueItem) =>
      processHook({
        queueItem,
        world,
        runId,
        global: suspension.globalThis,
      })
    )
  );

  // Then process steps and waits in parallel
  const [, waitTimeouts] = await Promise.all([
    Promise.all(
      stepItems.map((queueItem) =>
        processStep({
          queueItem,
          world,
          runId,
          workflowName,
          workflowStartedAt,
          global: suspension.globalThis,
        })
      )
    ),
    Promise.all(
      waitItems.map((queueItem) =>
        processWait({
          queueItem,
          world,
          runId,
        })
      )
    ),
  ]);

  // Find minimum timeout from waits
  const minTimeoutSeconds = waitTimeouts.reduce<number | null>(
    (min, timeout) => {
      if (timeout === null) return min;
      if (min === null) return timeout;
      return Math.min(min, timeout);
    },
    null
  );

  span?.setAttributes({
    ...Attribute.WorkflowRunStatus('workflow_suspended'),
    ...Attribute.WorkflowStepsCreated(stepItems.length),
    ...Attribute.WorkflowHooksCreated(hookItems.length),
    ...Attribute.WorkflowWaitsCreated(waitItems.length),
  });

  // If we encountered any waits, return the minimum timeout
  if (minTimeoutSeconds !== null) {
    return { timeoutSeconds: minTimeoutSeconds };
  }

  return {};
}
