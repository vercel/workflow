import { WorkflowRuntimeError } from '@workflow/errors';
import { parseDurationToDate, withResolvers } from '@workflow/utils';
import type { StringValue } from 'ms';
import { EventConsumerResult } from '../events-consumer.js';
import { type WaitInvocationQueueItem, WorkflowSuspension } from '../global.js';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from '../private.js';

export function createSleep(ctx: WorkflowOrchestratorContext) {
  return async function sleepImpl(
    param: StringValue | Date | number
  ): Promise<void> {
    const { promise, resolve } = withResolvers<void>();
    const correlationId = `wait_${ctx.generateUlid()}`;

    // Calculate the resume time
    const resumeAt = parseDurationToDate(param);

    // Add wait to invocations queue (using Map for O(1) operations)
    const waitItem: WaitInvocationQueueItem = {
      type: 'wait',
      correlationId,
      resumeAt,
    };
    ctx.invocationsQueue.set(correlationId, waitItem);

    ctx.eventsConsumer.subscribe((event) => {
      // If there are no events and we're waiting for wait_completed,
      // suspend the workflow until the wait fires
      if (!event) {
        scheduleWhenIdle(ctx, () => {
          ctx.onWorkflowError(
            new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
          );
        });
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== correlationId) {
        // We're not interested in this event - the correlationId belongs to a different entity
        return EventConsumerResult.NotConsumed;
      }

      // Check for wait_created event to mark this wait as having the event created
      if (event.eventType === 'wait_created') {
        // Mark this wait as having the created event, but keep it in the queue
        // O(1) lookup using Map
        const queueItem = ctx.invocationsQueue.get(correlationId);
        if (queueItem && queueItem.type === 'wait') {
          queueItem.hasCreatedEvent = true;
          queueItem.resumeAt = event.eventData.resumeAt;
        }
        return EventConsumerResult.Consumed;
      }

      // Check for wait_completed event
      if (event.eventType === 'wait_completed') {
        // Remove this wait from the invocations queue (O(1) delete using Map)
        ctx.invocationsQueue.delete(correlationId);

        // Wait has elapsed - chain through promiseQueue to ensure
        // deterministic ordering of all promise resolutions.
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          resolve();
        });
        return EventConsumerResult.Finished;
      }

      // An unexpected event type has been received, this event log looks corrupted. Let's fail immediately.
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new WorkflowRuntimeError(
            `Unexpected event type for wait ${correlationId} "${event.eventType}"`
          )
        );
      });
      return EventConsumerResult.Finished;
    });

    return promise;
  };
}
