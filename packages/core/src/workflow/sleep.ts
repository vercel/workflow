import { parseDurationToDate, withResolvers } from '@workflow/utils';
import type { StringValue } from 'ms';
import { EventConsumerResult } from '../events-consumer.js';
import { type WaitInvocationQueueItem, WorkflowSuspension } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';

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
        setTimeout(() => {
          ctx.onWorkflowError(
            new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
          );
        }, 0);
        return EventConsumerResult.NotConsumed;
      }

      // Check for wait_created event to mark this wait as having the event created
      if (
        event?.eventType === 'wait_created' &&
        event.correlationId === correlationId
      ) {
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
      if (
        event?.eventType === 'wait_completed' &&
        event.correlationId === correlationId
      ) {
        // Remove this wait from the invocations queue (O(1) delete using Map)
        ctx.invocationsQueue.delete(correlationId);

        // Wait has elapsed, resolve the sleep
        setTimeout(() => {
          resolve();
        }, 0);
        return EventConsumerResult.Finished;
      }

      return EventConsumerResult.NotConsumed;
    });

    return promise;
  };
}
