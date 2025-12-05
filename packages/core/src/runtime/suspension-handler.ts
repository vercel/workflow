import { waitUntil } from '@vercel/functions';
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
import type { Span } from '@opentelemetry/api';
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
  globalThis: typeof globalThis;
}

/**
 * Processes a single hook by creating it in the database and event log.
 */
async function processHook({
  queueItem,
  world,
  runId,
  globalThis,
}: ProcessHookParams): Promise<void> {
  try {
    // Create hook in database
    const hookMetadata =
      typeof queueItem.metadata === 'undefined'
        ? undefined
        : dehydrateStepArguments(queueItem.metadata, globalThis);
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
  globalThis: typeof globalThis;
}

/**
 * Processes a single step by creating it in the database and queueing execution.
 */
async function processStep({
  queueItem,
  world,
  runId,
  workflowName,
  workflowStartedAt,
  globalThis,
}: ProcessStepParams): Promise<void> {
  const ops: Promise<void>[] = [];
  const dehydratedInput = dehydrateStepArguments(
    {
      args: queueItem.args,
      closureVars: queueItem.closureVars,
    },
    globalThis
  );

  try {
    const step = await world.steps.create(runId, {
      stepId: queueItem.correlationId,
      stepName: queueItem.stepName,
      input: dehydratedInput as Serializable,
    });

    waitUntil(
      Promise.all(ops).catch((opErr) => {
        // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
        const isAbortError =
          opErr?.name === 'AbortError' || opErr?.name === 'ResponseAborted';
        if (!isAbortError) throw opErr;
      })
    );

    await queueMessage(
      world,
      `__wkf_step_${queueItem.stepName}`,
      {
        workflowName,
        workflowRunId: runId,
        workflowStartedAt,
        stepId: step.stepId,
        traceCarrier: await serializeTraceCarrier(),
        requestedAt: new Date(),
      },
      {
        idempotencyKey: queueItem.correlationId,
      }
    );
  } catch (err) {
    if (WorkflowAPIError.is(err) && err.status === 409) {
      // Step already exists, so we can skip it
      console.warn(
        `Step "${queueItem.stepName}" with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`
      );
      return;
    }
    throw err;
  }
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
        globalThis: suspension.globalThis,
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
          globalThis: suspension.globalThis,
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
