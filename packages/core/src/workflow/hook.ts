import type { HookReceivedEvent } from '@workflow/world';
import type { Hook, HookOptions } from '../create-hook.js';
import { EventConsumerResult } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import { webhookLogger } from '../logger.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { hydrateStepReturnValue } from '../serialization.js';
import { type PromiseWithResolvers, withResolvers } from '../util.js';

export function createCreateHook(ctx: WorkflowOrchestratorContext) {
  return function createHookImpl<T = any>(options: HookOptions = {}): Hook<T> {
    // Generate hook ID and token
    const correlationId = `hook_${ctx.generateUlid()}`;
    const token = options.token ?? ctx.generateNanoid();

    // Add hook creation to invocations queue
    ctx.invocationsQueue.push({
      type: 'hook',
      correlationId,
      token,
      metadata: options.metadata,
    });

    // Queue of hook events that have been received but not yet processed
    const payloadsQueue: HookReceivedEvent[] = [];

    // Queue of promises that resolve to the next hook payload
    const promises: PromiseWithResolvers<T>[] = [];

    let eventLogEmpty = false;

    webhookLogger.debug('Hook consumer setup', { correlationId, token });
    ctx.eventsConsumer.subscribe((event) => {
      // If there are no events and there are promises waiting,
      // it means the hook has been awaited, but an incoming payload has not yet been received.
      // In this case, the workflow should be suspended until the hook is resumed.
      if (!event) {
        eventLogEmpty = true;

        if (promises.length > 0) {
          setTimeout(() => {
            ctx.onWorkflowError(
              new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
            );
          }, 0);
          return EventConsumerResult.Finished;
        }
      }

      // Check for hook_created event to remove this hook from the queue if it was already created
      if (
        event?.eventType === 'hook_created' &&
        event.correlationId === correlationId
      ) {
        // Remove this hook from the invocations queue if it exists
        const index = ctx.invocationsQueue.findIndex(
          (item) => item.type === 'hook' && item.correlationId === correlationId
        );
        if (index !== -1) {
          ctx.invocationsQueue.splice(index, 1);
        }
        return EventConsumerResult.Consumed;
      }

      if (
        event?.eventType === 'hook_received' &&
        event.correlationId === correlationId
      ) {
        if (promises.length > 0) {
          const next = promises.shift();
          if (next) {
            // Reconstruct the payload from the event data
            const payload = hydrateStepReturnValue(
              event.eventData.payload,
              ctx.globalThis
            );
            next.resolve(payload);
          }
        } else {
          payloadsQueue.push(event);
        }

        return EventConsumerResult.Consumed;
      }

      return EventConsumerResult.NotConsumed;
    });

    // Helper function to create a new promise that waits for the next hook payload
    function createHookPromise(): Promise<T> {
      const resolvers = withResolvers<T>();
      if (payloadsQueue.length > 0) {
        const nextPayload = payloadsQueue.shift();
        if (nextPayload) {
          const payload = hydrateStepReturnValue(
            nextPayload.eventData.payload,
            ctx.globalThis
          );
          resolvers.resolve(payload);
          return resolvers.promise;
        }
      }

      if (eventLogEmpty) {
        // If the event log is already empty then we know the hook will not be resolved.
        // Treat this case as a "step not run" scenario and suspend the workflow.
        setTimeout(() => {
          ctx.onWorkflowError(
            new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
          );
        }, 0);
      }

      promises.push(resolvers);

      return resolvers.promise;
    }

    const hook: Hook<T> = {
      token,

      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): Promise<TResult1 | TResult2> {
        return createHookPromise().then(onfulfilled, onrejected);
      },

      // Support `for await (const payload of hook) { … }` syntax
      async *[Symbol.asyncIterator]() {
        while (true) {
          yield await this;
        }
      },
    };

    return hook;
  };
}
