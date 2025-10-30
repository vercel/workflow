import type { StringValue } from 'ms';
import ms from 'ms';
import { EventConsumerResult } from '../events-consumer.js';
import { type WaitInvocationQueueItem, WorkflowSuspension } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { withResolvers } from '../util.js';

export function createSleep(ctx: WorkflowOrchestratorContext) {
  return async function sleepImpl(param: StringValue | Date): Promise<void> {
    const { promise, resolve } = withResolvers<void>();
    const correlationId = `wait_${ctx.generateUlid()}`;

    // Calculate the resume time
    let resumeAt: Date;
    if (typeof param === 'string') {
      const durationMs = ms(param);
      if (typeof durationMs !== 'number' || durationMs < 0) {
        throw new Error(
          `Invalid sleep duration: "${param}". Expected a valid duration string like "1s", "1m", "1h", etc.`
        );
      }
      resumeAt = new Date(Date.now() + durationMs);
    } else if (
      param instanceof Date ||
      (param &&
        typeof param === 'object' &&
        typeof (param as any).getTime === 'function')
    ) {
      // Handle both Date instances and date-like objects (from deserialization)
      const dateParam =
        param instanceof Date ? param : new Date((param as any).getTime());
      resumeAt = dateParam;
    } else {
      throw new Error(
        `Invalid sleep parameter. Expected a duration string or Date object.`
      );
    }

    // Add wait to invocations queue
    ctx.invocationsQueue.push({
      type: 'wait',
      correlationId,
      resumeAt,
    });

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
        const waitItem = ctx.invocationsQueue.find(
          (item) => item.type === 'wait' && item.correlationId === correlationId
        ) as WaitInvocationQueueItem | undefined;
        if (waitItem) {
          waitItem.hasCreatedEvent = true;
          waitItem.resumeAt = event.eventData.resumeAt;
        }
        return EventConsumerResult.Consumed;
      }

      // Check for wait_completed event
      if (
        event?.eventType === 'wait_completed' &&
        event.correlationId === correlationId
      ) {
        // Remove this wait from the invocations queue
        const index = ctx.invocationsQueue.findIndex(
          (item) => item.type === 'wait' && item.correlationId === correlationId
        );
        if (index !== -1) {
          ctx.invocationsQueue.splice(index, 1);
        }

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
