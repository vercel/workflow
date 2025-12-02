/**
 * SharedWorker entry point for browser workflow execution.
 *
 * This worker handles:
 * - Workflow triggering and status queries
 * - Queue processing for step execution
 * - Subscriptions for real-time updates
 */

import type { World, WorkflowRun, Step } from '@workflow/world';
import { createBrowserWorld } from '../world.js';
import { startQueueProcessor } from '../queue.js';
import { executeWorkflow } from './engine.js';
import { getWorkflowRegistry } from './registry.js';
import type {
  AnyWorkerRequest,
  AnyWorkerResponse,
  AnyWorkerEvent,
  TriggerResponse,
  ListRunsResponse,
  GetStepsResponse,
  GetEventsResponse,
  RunUpdatedEvent,
  StepUpdatedEvent,
  RunCompletedEvent,
  RunFailedEvent,
} from './message-types.js';

// Declare SharedWorkerGlobalScope for TypeScript
declare const self: SharedWorkerGlobalScope;

// Connected ports
const ports = new Set<MessagePort>();

// Subscriptions: runId -> Set of ports
const subscriptions = new Map<string, Set<MessagePort>>();

// World instance (initialized once)
let world: World | null = null;

/**
 * Broadcast an event to all subscribed ports.
 */
function broadcastToSubscribers(runId: string, event: AnyWorkerEvent): void {
  const subscribedPorts = subscriptions.get(runId);
  if (subscribedPorts) {
    for (const port of subscribedPorts) {
      try {
        port.postMessage(event);
      } catch {
        // Port may be closed, remove it
        subscribedPorts.delete(port);
      }
    }
  }
}

/**
 * Broadcast run update to subscribers.
 */
export function notifyRunUpdate(run: WorkflowRun): void {
  const event: RunUpdatedEvent = {
    type: 'RUN_UPDATED',
    runId: run.runId,
    run,
  };
  broadcastToSubscribers(run.runId, event);
}

/**
 * Broadcast step update to subscribers.
 */
export function notifyStepUpdate(step: Step): void {
  const event: StepUpdatedEvent = {
    type: 'STEP_UPDATED',
    runId: step.runId,
    step,
  };
  broadcastToSubscribers(step.runId, event);
}

/**
 * Handle incoming messages from the main thread.
 */
async function handleMessage(
  port: MessagePort,
  request: AnyWorkerRequest,
  currentWorld: World
): Promise<AnyWorkerResponse<unknown>> {
  try {
    switch (request.type) {
      case 'TRIGGER': {
        const { workflowId, args } = request;

        // Create workflow run
        const run = await currentWorld.runs.create({
          workflowName: workflowId,
          deploymentId: 'browser',
          input: args,
        });

        // Queue the workflow for execution
        await currentWorld.queue(`__wkf_workflow_${workflowId}` as any, {
          runId: run.runId,
        });

        const response: TriggerResponse = { runId: run.runId };
        return { id: request.id, success: true, data: response };
      }

      case 'GET_STATUS': {
        const run = await currentWorld.runs.get(request.runId);
        return { id: request.id, success: true, data: run };
      }

      case 'LIST_RUNS': {
        const result = await currentWorld.runs.list({
          workflowName: request.workflowName,
          status: request.status as WorkflowRun['status'],
          pagination: {
            limit: request.limit,
            cursor: request.cursor,
          },
        });
        const response: ListRunsResponse = result;
        return { id: request.id, success: true, data: response };
      }

      case 'CANCEL': {
        const run = await currentWorld.runs.cancel(request.runId);
        notifyRunUpdate(run);
        return { id: request.id, success: true, data: run };
      }

      case 'PAUSE': {
        const run = await currentWorld.runs.pause(request.runId);
        notifyRunUpdate(run);
        return { id: request.id, success: true, data: run };
      }

      case 'RESUME': {
        const run = await currentWorld.runs.resume(request.runId);
        notifyRunUpdate(run);

        // Re-queue for execution
        await currentWorld.queue(`__wkf_workflow_${run.workflowName}` as any, {
          runId: run.runId,
        });

        return { id: request.id, success: true, data: run };
      }

      case 'SUBSCRIBE': {
        if (!subscriptions.has(request.runId)) {
          subscriptions.set(request.runId, new Set());
        }
        subscriptions.get(request.runId)!.add(port);

        // Return current status
        const run = await currentWorld.runs.get(request.runId);
        return { id: request.id, success: true, data: run };
      }

      case 'UNSUBSCRIBE': {
        subscriptions.get(request.runId)?.delete(port);
        return { id: request.id, success: true, data: null };
      }

      case 'GET_STEPS': {
        const result = await currentWorld.steps.list({ runId: request.runId });
        const response: GetStepsResponse = result;
        return { id: request.id, success: true, data: response };
      }

      case 'GET_EVENTS': {
        const result = await currentWorld.events.list({ runId: request.runId });
        const response: GetEventsResponse = result;
        return { id: request.id, success: true, data: response };
      }

      default: {
        // TypeScript exhaustiveness check - this should never happen
        const _exhaustive: never = request;
        return {
          id: (_exhaustive as AnyWorkerRequest).id,
          success: false as const,
          error: `Unknown request type: ${(request as AnyWorkerRequest).type}`,
        };
      }
    }
  } catch (error) {
    return {
      id: request.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Initialize the SharedWorker.
 */
self.onconnect = async (event: MessageEvent) => {
  const port = event.ports[0];
  ports.add(port);

  // Initialize world on first connection
  if (!world) {
    const browserWorld = await createBrowserWorld({ database: 'workflows.db' });
    world = browserWorld;

    // Start queue processor
    startQueueProcessor(browserWorld.db, {
      workflow: async (message, _meta) => {
        if (!('runId' in message)) return;

        const run = await world!.runs.get(message.runId);
        const workflowFn = getWorkflowRegistry().get(run.workflowName);

        if (!workflowFn) {
          console.error(`Workflow not found: ${run.workflowName}`);
          await world!.runs.update(run.runId, {
            status: 'failed',
            error: { message: `Workflow not found: ${run.workflowName}` },
          });
          return;
        }

        try {
          // Update status to running
          await world!.runs.update(run.runId, { status: 'running' });
          notifyRunUpdate(await world!.runs.get(run.runId));

          // Execute workflow
          const events = await world!.events.list({ runId: run.runId });
          const result = await executeWorkflow(
            workflowFn,
            run,
            events.data,
            world!
          );

          // Update with result
          const completedRun = await world!.runs.update(run.runId, {
            status: 'completed',
            output: result as any,
          });

          const completedEvent: RunCompletedEvent = {
            type: 'RUN_COMPLETED',
            runId: run.runId,
            run: completedRun,
          };
          broadcastToSubscribers(run.runId, completedEvent);
        } catch (error) {
          const failedRun = await world!.runs.update(run.runId, {
            status: 'failed',
            error: {
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          });

          const failedEvent: RunFailedEvent = {
            type: 'RUN_FAILED',
            runId: run.runId,
            run: failedRun,
            error: error instanceof Error ? error.message : String(error),
          };
          broadcastToSubscribers(run.runId, failedEvent);
        }
      },
      step: async (_message, _meta) => {
        // Step execution is handled by the workflow engine
        // This is for future step-level queueing if needed
      },
    });
  }

  // Handle messages from this port
  port.onmessage = async (msgEvent: MessageEvent<AnyWorkerRequest>) => {
    const response = await handleMessage(port, msgEvent.data, world!);
    port.postMessage(response);
  };

  // Clean up on disconnect
  port.onmessageerror = () => {
    ports.delete(port);
    // Remove from all subscriptions
    for (const [runId, subscribedPorts] of subscriptions) {
      subscribedPorts.delete(port);
      if (subscribedPorts.size === 0) {
        subscriptions.delete(runId);
      }
    }
  };

  port.start();
};
