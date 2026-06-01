import { ReplayDivergenceError } from '@workflow/errors';
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
        const eventResumeAt = event.eventData?.resumeAt;
        if (eventResumeAt !== undefined) {
          const queueItem = ctx.invocationsQueue.get(correlationId);
          const expectedResumeAt =
            queueItem && queueItem.type === 'wait'
              ? queueItem.resumeAt
              : resumeAt;
          const eventResumeAtDate = new Date(eventResumeAt);
          const eventResumeAtMs = eventResumeAtDate.getTime();
          const expectedResumeAtMs = expectedResumeAt.getTime();
          const eventResumeAtForMessage = Number.isFinite(eventResumeAtMs)
            ? eventResumeAtDate.toISOString()
            : String(eventResumeAt);

          if (eventResumeAtMs !== expectedResumeAtMs) {
            ctx.promiseQueue = ctx.promiseQueue.then(() => {
              ctx.onWorkflowError(
                new ReplayDivergenceError(
                  `Replay divergence: wait_completed event for ${correlationId} has resumeAt "${eventResumeAtForMessage}", but the current wait consumer expects "${expectedResumeAt.toISOString()}"`,
                  { eventId: event.eventId }
                )
              );
            });
            return EventConsumerResult.Finished;
          }
        }

        // Remove this wait from the invocations queue (O(1) delete using Map)
        ctx.invocationsQueue.delete(correlationId);

        // Wait has elapsed - chain through promiseQueue to ensure
        // deterministic ordering of all promise resolutions.
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          resolve();
        });
        return EventConsumerResult.Finished;
      }

      // This replay installed a different consumer than the stored event needs.
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new ReplayDivergenceError(
            `Replay divergence: Unexpected event type for wait ${correlationId} "${event.eventType}"`,
            { eventId: event.eventId }
          )
        );
      });
      return EventConsumerResult.Finished;
    });

    return promise;
  };
}
