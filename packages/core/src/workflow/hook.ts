import { CorruptedEventLogError, HookConflictError } from '@workflow/errors';
import { type PromiseWithResolvers, withResolvers } from '@workflow/utils';
import type { HookConflictEvent } from '@workflow/world';
import type { Hook, HookOptions } from '../create-hook.js';
import { EventConsumerResult } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import { webhookLogger } from '../logger.js';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from '../private.js';
import { hydrateStepReturnValue } from '../serialization.js';

export function createCreateHook(ctx: WorkflowOrchestratorContext) {
  return function createHookImpl<T = any>(options: HookOptions = {}): Hook<T> {
    // Generate hook ID and token
    const correlationId = `hook_${ctx.generateUlid()}`;
    const token = options.token ?? ctx.generateNanoid();

    // Add hook creation to invocations queue (using Map for O(1) operations)
    const isWebhook = options.isWebhook ?? false;

    ctx.invocationsQueue.set(correlationId, {
      type: 'hook',
      correlationId,
      token,
      metadata: options.metadata,
      isWebhook,
    });

    // Queue of buffered hook payloads (received before the workflow
    // awaited the hook). Each entry's `payload` promise resolves from a
    // `ctx.promiseQueue` slot chained at the moment its `hook_received`
    // was consumed — i.e. at the payload's position in the event log,
    // exactly like step_completed / immediately-delivered hooks. The
    // serial queue runs each slot's async hydration to completion before
    // the next, so an earlier-in-log payload resolves first regardless of
    // how long it takes to decrypt. `iterator.next()` returns the
    // pre-wired `payload` promise so the resolution stays anchored to the
    // early log position rather than being re-scheduled at the (later)
    // await site.
    //
    // `markClaimed` is called when a consumer (`iterator.next()`/`await`)
    // takes this payload; it releases the cross-entity ordering barrier
    // (see `ctx.pendingHookDeliveries`). The barrier persists until the
    // claim so that a later-in-log entity (sleep) which is consumed before
    // the claim still defers behind this payload.
    const payloadsQueue: { payload: Promise<T>; markClaimed: () => void }[] =
      [];

    // Queue of promises that resolve to the next hook payload
    const promises: PromiseWithResolvers<T>[] = [];

    let eventLogEmpty = false;

    // Track if the event log confirms disposal happened (replay no-op)
    let hasDisposedEvent = false;

    // Track if we have a conflict so we can reject future awaits
    let hasConflict = false;
    let conflictErrorRef: HookConflictError | null = null;

    webhookLogger.debug('Hook consumer setup', { correlationId, token });
    ctx.eventsConsumer.subscribe((event) => {
      // If there are no events and there are promises waiting,
      // it means the hook has been awaited, but an incoming payload has not yet been received.
      // In this case, the workflow should be suspended until the hook is resumed.
      if (!event) {
        eventLogEmpty = true;

        if (promises.length > 0 && payloadsQueue.length === 0) {
          scheduleWhenIdle(ctx, () => {
            ctx.onWorkflowError(
              new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
            );
          });
        }
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== correlationId) {
        // We're not interested in this event - the correlationId belongs to a different entity
        return EventConsumerResult.NotConsumed;
      }

      const eventToken =
        'eventData' in event && event.eventData && 'token' in event.eventData
          ? event.eventData.token
          : undefined;

      if (typeof eventToken === 'string' && eventToken !== token) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(
            new CorruptedEventLogError(
              `Corrupted event log: hook event ${event.eventType} for ${correlationId} belongs to token "${eventToken}", but the current hook consumer expects "${token}"`
            )
          );
        });
        return EventConsumerResult.Finished;
      }

      // Check for hook_created event to mark this hook as already created
      if (event.eventType === 'hook_created') {
        const queueItem = ctx.invocationsQueue.get(correlationId);
        if (queueItem && queueItem.type === 'hook') {
          queueItem.hasCreatedEvent = true;
        }
        return EventConsumerResult.Consumed;
      }

      // Handle hook_conflict event - another workflow is using this token
      if (event.eventType === 'hook_conflict') {
        // Remove this hook from the invocations queue
        ctx.invocationsQueue.delete(correlationId);

        // Store the conflict event so we can reject any awaited promises.
        // Chain through promiseQueue to ensure deterministic ordering.
        const conflictEvent = event as HookConflictEvent;
        const conflictError = new HookConflictError(
          conflictEvent.eventData.token
        );

        // Mark that we have a conflict so future awaits also reject
        hasConflict = true;
        conflictErrorRef = conflictError;

        // Capture and drain pending promises synchronously so the null event
        // handler won't see them and trigger a spurious WorkflowSuspension.
        // The actual rejections are deferred through promiseQueue for ordering.
        const pendingPromises = promises.slice();
        promises.length = 0;

        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          for (const resolver of pendingPromises) {
            resolver.reject(conflictError);
          }
        });

        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'hook_received') {
        if (promises.length > 0) {
          const next = promises.shift();
          if (next) {
            // Reconstruct the payload from the event data.
            // Chain through ctx.promiseQueue to ensure that async
            // deserialization (e.g., decryption) resolves in event log order.
            ctx.pendingDeliveries++;
            ctx.promiseQueue = ctx.promiseQueue.then(async () => {
              try {
                const payload = await hydrateStepReturnValue(
                  event.eventData.payload,
                  ctx.runId,
                  ctx.encryptionKey,
                  ctx.globalThis
                );
                next.resolve(payload as T);
              } catch (error) {
                next.reject(error);
              } finally {
                ctx.pendingDeliveries--;
              }
            });
          }
        } else {
          // No consumer is awaiting yet. Resolve this payload through a
          // promiseQueue slot chained NOW (at its log position), parking
          // the value on `payload` for a later `iterator.next()` claim.
          //
          // Also register a barrier keyed by the source eventId so a
          // later-in-log entity that resolves with fewer microtask hops
          // (notably sleep's synchronous `wait_completed`) defers behind
          // this delivery and cannot win a `Promise.race` it should lose.
          // Entities resolving from a later log event consult the barrier
          // via `awaitEarlierHookDeliveries`.
          const delivery = withResolvers<T>();
          const sourceEventId = event.eventId;
          const deliverySettled = withResolvers<void>();
          let claimed = false;
          const releaseBarrier = () => {
            ctx.pendingHookDeliveries?.delete(sourceEventId);
            deliverySettled.resolve();
          };
          // `markClaimed` is invoked from `createHookPromise` the moment a
          // consumer (`await hook` / `iterator.next()`) takes this payload.
          // It releases the ordering barrier, but only after the consumer's
          // branch decision has actually committed.
          //
          // The consumer reaches a buffered payload through a chain of
          // microtasks whose depth we cannot know (a direct `await hook`, a
          // `for await` over the async iterator's `yield await this`, etc.),
          // so counting microtask hops is fragile. Instead, once the
          // payload settles we release the barrier on the next MACROTASK
          // (`setTimeout(0)`), which runs only after the entire pending
          // microtask queue has drained — including the consumer's full
          // await-chain — regardless of its depth. This is the same
          // macrotask-boundary technique `scheduleWhenIdle` uses to wait
          // out multi-round deliveries, and is fully hop-count- and
          // hydration/decryption-time independent.
          const markClaimed = () => {
            if (claimed) {
              return;
            }
            claimed = true;
            const scheduleRelease = () => {
              // Host `setTimeout` (matching `scheduleWhenIdle`); a
              // macrotask runs after the full microtask queue drains.
              setTimeout(releaseBarrier, 0);
            };
            delivery.promise.then(scheduleRelease, scheduleRelease);
          };
          ctx.pendingHookDeliveries?.set(
            sourceEventId,
            deliverySettled.promise
          );
          ctx.pendingDeliveries++;
          ctx.promiseQueue = ctx.promiseQueue.then(async () => {
            try {
              const payload = await hydrateStepReturnValue(
                event.eventData.payload,
                ctx.runId,
                ctx.encryptionKey,
                ctx.globalThis
              );
              delivery.resolve(payload as T);
            } catch (error) {
              delivery.reject(error);
            } finally {
              ctx.pendingDeliveries--;
            }
          });
          payloadsQueue.push({ payload: delivery.promise, markClaimed });
        }

        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'hook_disposed') {
        // Terminal state - remove from queue (like step_completed/wait_completed)
        ctx.invocationsQueue.delete(correlationId);
        // Mark that the event log confirms disposal happened
        hasDisposedEvent = true;
        // We're done processing any more events for this hook
        return EventConsumerResult.Finished;
      }

      // An unexpected event type has been received, this event log looks corrupted. Let's fail immediately.
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new CorruptedEventLogError(
            `Unexpected event type for hook ${correlationId} (token: ${token}) "${event.eventType}"`
          )
        );
      });
      return EventConsumerResult.Finished;
    });

    // Track if the hook has been disposed
    let isDisposed = false;

    // Helper function to create a new promise that waits for the next hook payload
    function createHookPromise(): Promise<T> {
      const resolvers = withResolvers<T>();

      // If we have a conflict, reject through the promiseQueue to maintain
      // deterministic ordering with any prior queued resolutions.
      if (hasConflict && conflictErrorRef) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          resolvers.reject(conflictErrorRef);
        });
        return resolvers.promise;
      }

      if (payloadsQueue.length > 0) {
        const nextDelivery = payloadsQueue.shift();
        if (nextDelivery) {
          // The payload was already scheduled to resolve through a
          // promiseQueue slot at its log position (buffering branch
          // above). Return that promise directly so resolution order
          // stays anchored to the payload's log position, not this later
          // claim site. Releasing the ordering barrier here (on claim,
          // after the returned promise's continuations are wired up by
          // the caller) lets any later entity that was deferring behind
          // this payload proceed.
          nextDelivery.markClaimed();
          return nextDelivery.payload;
        }
      }

      if (eventLogEmpty) {
        scheduleWhenIdle(ctx, () => {
          ctx.onWorkflowError(
            new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
          );
        });
      }

      promises.push(resolvers);

      return resolvers.promise;
    }

    // Helper function to dispose the hook
    function disposeHook(): void {
      if (isDisposed) {
        return; // Already disposed, nothing to do
      }
      isDisposed = true;

      // If the event log already contains hook_disposed, this is a replay — no-op
      if (hasDisposedEvent) {
        return;
      }

      // Set disposed flag on the existing queue item
      const queueItem = ctx.invocationsQueue.get(correlationId);
      if (queueItem && queueItem.type === 'hook') {
        queueItem.disposed = true;
      }

      // Drain any pending promises that are waiting for payloads.
      // Without this, promises created by `await hook` or the async iterator's
      // `yield await this` would hang forever since the event consumer will
      // never deliver another hook_received after disposal.
      if (promises.length > 0) {
        promises.length = 0;
        scheduleWhenIdle(ctx, () => {
          ctx.onWorkflowError(
            new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
          );
        });
      }

      webhookLogger.debug('Hook disposed', { correlationId, token });
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
        while (!isDisposed) {
          yield await this;
        }
      },

      dispose: disposeHook,

      [Symbol.dispose]: disposeHook,
    };

    // Also register with the VM's Symbol.dispose so `using` works inside
    // the workflow sandbox (the VM may have a polyfilled Symbol.dispose
    // that differs from the host's).
    const vmDispose = ctx.globalThis.Symbol.dispose;
    if (vmDispose && vmDispose !== Symbol.dispose) {
      (hook as any)[vmDispose] = disposeHook;
    }

    return hook;
  };
}
