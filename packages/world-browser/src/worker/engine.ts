/**
 * Workflow execution engine for browser.
 *
 * This handles executing workflow functions with deterministic context
 * and event replay for resumption.
 */

import type { Event, World, WorkflowRun } from '@workflow/world';
import { createDeterministicContext } from '../deterministic.js';
import type { WorkflowFunction } from './registry.js';

/**
 * Events consumer for replaying events during workflow execution.
 */
class EventsConsumer {
  private events: Event[];
  private index: number = 0;
  private subscribers: Array<(event: Event | null) => void> = [];

  constructor(events: Event[]) {
    this.events = events;
  }

  /**
   * Subscribe to event consumption.
   */
  subscribe(callback: (event: Event | null) => void): void {
    this.subscribers.push(callback);
  }

  /**
   * Consume the next event if it matches the expected type.
   */
  consume(expectedType: string): Event | null {
    if (this.index >= this.events.length) {
      return null;
    }

    const event = this.events[this.index];
    if (event.eventType === expectedType) {
      this.index++;
      this.notifySubscribers(event);
      return event;
    }

    return null;
  }

  /**
   * Peek at the next event without consuming it.
   */
  peek(): Event | null {
    if (this.index >= this.events.length) {
      return null;
    }
    return this.events[this.index];
  }

  /**
   * Check if all events have been consumed.
   */
  isExhausted(): boolean {
    return this.index >= this.events.length;
  }

  private notifySubscribers(event: Event | null): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

/**
 * Hydrate workflow arguments from serialized input.
 */
function hydrateWorkflowArguments(input: unknown[]): unknown[] {
  // For now, simple passthrough. In the future, this could handle
  // special types like Date, ArrayBuffer, etc.
  return input ?? [];
}

/**
 * Dehydrate workflow return value for serialization.
 */
function dehydrateWorkflowReturnValue(value: unknown): unknown {
  // For now, simple passthrough. In the future, this could handle
  // special types like Date, ArrayBuffer, etc.
  return value;
}

/**
 * Execute a workflow with deterministic context.
 *
 * @param workflowFn - The workflow function to execute
 * @param run - The workflow run record
 * @param events - Previous events for replay
 * @param world - The world instance for storage/queue operations
 */
export async function executeWorkflow(
  workflowFn: WorkflowFunction,
  run: WorkflowRun,
  events: Event[],
  _world: World
): Promise<unknown> {
  const startedAt = run.startedAt ?? run.createdAt;

  // Create deterministic context
  const ctx = createDeterministicContext(run.runId, +startedAt);

  try {
    // Set up events consumer for replay
    const eventsConsumer = new EventsConsumer(events);

    // Subscribe to update timestamp as events are consumed
    eventsConsumer.subscribe((event) => {
      if (event?.createdAt) {
        ctx.updateTimestamp(+event.createdAt);
      }
    });

    // Hydrate arguments
    const args = hydrateWorkflowArguments(run.input as unknown[]);

    // Execute the workflow function
    const result = await workflowFn(...args);

    // Dehydrate result
    return dehydrateWorkflowReturnValue(result);
  } finally {
    // Always restore original globals
    ctx.restore();
  }
}

/**
 * Create a step runner for use within workflow execution.
 * This is used by the transformed step functions to execute steps.
 */
export function createStepRunner(
  world: World,
  runId: string,
  _eventsConsumer: EventsConsumer
) {
  return async function runStep<T>(
    stepId: string,
    stepName: string,
    stepFn: () => Promise<T>
  ): Promise<T> {
    // Check if we have a cached result from previous execution
    try {
      const existingStep = await world.steps.get(runId, stepId);
      if (
        existingStep.status === 'completed' &&
        existingStep.output !== undefined
      ) {
        // Return cached result
        return existingStep.output as T;
      }
    } catch {
      // Step doesn't exist yet, create it
    }

    // Create or update step record
    try {
      await world.steps.create(runId, {
        stepId,
        stepName,
        input: [],
      });
    } catch {
      // Step might already exist
    }

    // Update step to running
    await world.steps.update(runId, stepId, { status: 'running' });

    try {
      // Execute the step function
      const result = await stepFn();

      // Record step completion
      await world.steps.update(runId, stepId, {
        status: 'completed',
        output: result as any,
      });

      // Create step completion event
      await world.events.create(runId, {
        eventType: 'step_completed',
        correlationId: stepId,
        eventData: { result },
      });

      return result;
    } catch (error) {
      // Record step failure
      await world.steps.update(runId, stepId, {
        status: 'failed',
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });

      throw error;
    }
  };
}
