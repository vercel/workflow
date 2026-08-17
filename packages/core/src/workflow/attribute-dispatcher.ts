import { ReplayDivergenceError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { AttributeChange } from '@workflow/world';
import { EventConsumerResult } from '../events-consumer.js';
import {
  type AttributeInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from '../private.js';

export function createSetAttributes(ctx: WorkflowOrchestratorContext) {
  return async function setAttributes(
    changes: AttributeChange[],
    options: { allowReservedAttributes?: boolean } = {}
  ): Promise<void> {
    const { promise, resolve } = withResolvers<void>();
    const correlationId = `attr_${ctx.generateUlid()}`;
    const queueItem: AttributeInvocationQueueItem = {
      type: 'attribute',
      correlationId,
      changes,
      ...(options.allowReservedAttributes === true
        ? { allowReservedAttributes: true }
        : {}),
    };
    ctx.invocationsQueue.set(correlationId, queueItem);

    ctx.eventsConsumer.subscribe((event) => {
      if (!event) {
        scheduleWhenIdle(ctx, () => {
          ctx.onWorkflowError(
            new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
          );
        });
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== correlationId) {
        return EventConsumerResult.NotConsumed;
      }

      if (
        event.eventType !== 'attr_set' ||
        event.eventData.writer.type !== 'workflow' ||
        JSON.stringify(event.eventData.changes) !== JSON.stringify(changes) ||
        (event.eventData.allowReservedAttributes === true) !==
          (options.allowReservedAttributes === true)
      ) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(
            new ReplayDivergenceError(
              `Replay divergence: Unexpected attribute event for ${correlationId}`,
              { eventId: event.eventId }
            )
          );
        });
        return EventConsumerResult.Finished;
      }

      ctx.invocationsQueue.delete(correlationId);
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        resolve();
      });
      return EventConsumerResult.Finished;
    });

    return promise;
  };
}
