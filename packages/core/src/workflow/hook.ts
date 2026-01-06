import { type PromiseWithResolvers, withResolvers } from '@workflow/utils';
import type { HookConflictEvent, HookReceivedEvent } from '@workflow/world';
import type { Hook, HookOptions } from '../create-hook.js';
import { EventConsumerResult } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import { webhookLogger } from '../logger.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { hydrateStepReturnValue } from '../serialization.js';
import { ERROR_SLUGS, WorkflowRuntimeError } from '@workflow/errors';

export function createCreateHook(ctx: WorkflowOrchestratorContext) {
  return function createHookImpl<T = any>(options: HookOptions = {}): Hook<T> {
    // Generate hook ID and token
    const correlationId = `hook_${ctx.generateUlid()}`;
    const token = options.token ?? ctx.generateNanoid();

    // Add hook creation to invocations queue (using Map for O(1) operations)
    ctx.invocationsQueue.set(correlationId, {
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

    // Track if we have a conflict so we can reject future awaits
    let hasConflict = false;
    let conflictErrorRef: WorkflowRuntimeError | null = null;

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
        }
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== correlationId) {
        // We're not interested in this event - the correlationId belongs to a different entity
        return EventConsumerResult.NotConsumed;
      }

      // Check for hook_created event to remove this hook from the queue if it was already created
      if (event.eventType === 'hook_created') {
        // Remove this hook from the invocations queue (O(1) delete using Map)
        ctx.invocationsQueue.delete(correlationId);
        return EventConsumerResult.Consumed;
      }

      // Handle hook_conflict event - another workflow is using this token
      if (event.eventType === 'hook_conflict') {
        // Remove this hook from the invocations queue
        ctx.invocationsQueue.delete(correlationId);

        // Store the conflict event so we can reject any awaited promises
        const conflictEvent = event as HookConflictEvent;
        const conflictError = new WorkflowRuntimeError(
          `Hook token "${conflictEvent.eventData.token}" is already in use by another workflow`,
          { slug: ERROR_SLUGS.HOOK_CONFLICT }
        );

        // Reject any pending promises
        for (const resolver of promises) {
          resolver.reject(conflictError);
        }
        promises.length = 0;

        // Mark that we have a conflict so future awaits also reject
        hasConflict = true;
        conflictErrorRef = conflictError;

        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'hook_received') {
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

      if (event.eventType === 'hook_disposed') {
        // If a hook is explicitly disposed, we're done processing any more
        // events for it
        return EventConsumerResult.Finished;
      }

      // An unexpected event type has been received, this event log looks corrupted. Let's fail immediately.
      setTimeout(() => {
        ctx.onWorkflowError(
          new WorkflowRuntimeError(
            `Unexpected event type for hook ${correlationId} (token: ${token}) "${event.eventType}"`
          )
        );
      }, 0);
      return EventConsumerResult.Finished;
    });

    // Helper function to create a new promise that waits for the next hook payload
    function createHookPromise(): Promise<T> {
      const resolvers = withResolvers<T>();

      // If we have a conflict, reject immediately
      // This handles the iterator case where each await should reject
      if (hasConflict && conflictErrorRef) {
        resolvers.reject(conflictErrorRef);
        return resolvers.promise;
      }

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
