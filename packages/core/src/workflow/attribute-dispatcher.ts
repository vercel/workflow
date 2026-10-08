import { FatalError, ReplayDivergenceError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { AttributeChange } from '@workflow/world';
import {
  AttributeValidationError,
  validateAttributeEventDataSize,
} from '@workflow/world/attributes-validation';
import { EventConsumerResult } from '../events-consumer.js';
import type { AttributeInvocationQueueItem } from '../global.js';
import {
  scheduleWorkflowSuspension,
  type WorkflowOrchestratorContext,
} from '../private.js';

export function createSetAttributes(ctx: WorkflowOrchestratorContext) {
  return async function setAttributes(
    changes: AttributeChange[],
    options: { allowReservedAttributes?: boolean } = {}
  ): Promise<void> {
    const { promise, resolve } = withResolvers<void>();
    const correlationId = `attr_${ctx.generateUlid()}`;
    try {
      validateAttributeEventDataSize({
        changes,
        writer: { type: 'workflow' },
        ...(options.allowReservedAttributes === true
          ? { allowReservedAttributes: true }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof AttributeValidationError)) throw error;
      // Preserve old local-world histories, but reject new writes now so a
      // catch path runs before unrelated replay events (including races).
      const persisted = ctx.eventsConsumer.events.some(
        (event) =>
          event.eventType === 'attr_set' &&
          event.correlationId === correlationId
      );
      if (!persisted) throw new FatalError(error.message);
    }
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
        scheduleWorkflowSuspension(ctx);
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
