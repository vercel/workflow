import { HookConflictError, ReplayDivergenceError } from '@workflow/errors';
import { type PromiseWithResolvers, withResolvers } from '@workflow/utils';
import type { HookConflictEvent } from '@workflow/world';
import type { Hook, HookOptions } from '../create-hook.js';
import { EventConsumerResult } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import { webhookLogger } from '../logger.js';
import {
  awaitEarlierDeliveries,
  registerDeliveryBarrier,
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

    // Queue of buffered hook payloads (received before the workflow awaited
    // the hook). Each entry's `claim()` builds the consumer-facing promise
    // from the captured hydration outcome and orders it deterministically by
    // event-log position against any concurrent branch-deciding resolution
    // (see `ctx.pendingDeliveryBarriers`).
    const payloadsQueue: { claim: () => Promise<T> }[] = [];

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
            new ReplayDivergenceError(
              `Replay divergence: hook event ${event.eventType} for ${correlationId} belongs to token "${eventToken}", but the current hook consumer expects "${token}"`,
              { eventId: event.eventId }
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
          conflictEvent.eventData.token,
          conflictEvent.eventData.conflictingRunId
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
        // Register a 'hook' delivery barrier at this event's log index so a
        // later-in-log `wait_completed` is delivered only after this hook,
        // and so this hook is delivered only after every earlier-in-log
        // `wait_completed` — keeping any `Promise.race` against a wait
        // deterministic and aligned with the committed event log, regardless
        // of microtask-hop count, hydration time, or race-argument order.
        // See `ctx.pendingDeliveryBarriers`.
        const eventIndex = ctx.eventsConsumer.eventIndex;
        const barrier = registerDeliveryBarrier(ctx, eventIndex, 'hook');

        if (promises.length > 0) {
          const next = promises.shift();
          if (next) {
            // A consumer is already awaiting. Hydrate through a promiseQueue
            // slot (so async deserialization stays in event-log order), then
            // defer behind earlier waits before resolving. The deferral runs
            // OFF the serial queue (it may wait on an earlier wait delivery
            // and blocking a queue slot on that would deadlock the queue).
            ctx.pendingDeliveries++;
            let hydrateOutcome:
              | { ok: true; value: T }
              | { ok: false; error: unknown };
            ctx.promiseQueue = ctx.promiseQueue.then(async () => {
              try {
                const payload = await hydrateStepReturnValue(
                  event.eventData.payload,
                  ctx.runId,
                  ctx.encryptionKey,
                  ctx.globalThis
                );
                hydrateOutcome = { ok: true, value: payload as T };
              } catch (error) {
                hydrateOutcome = { ok: false, error };
              } finally {
                ctx.pendingDeliveries--;
              }
              void awaitEarlierDeliveries(ctx, eventIndex, ['wait']).then(
                () => {
                  barrier.markDelivered();
                  if (hydrateOutcome.ok) {
                    next.resolve(hydrateOutcome.value);
                  } else {
                    next.reject(hydrateOutcome.error);
                  }
                }
              );
            });
          }
        } else {
          // No consumer is awaiting yet. Hydrate through a promiseQueue slot
          // at this log position and park the OUTCOME (value or error) for a
          // later `iterator.next()` / `await hook` claim. We capture the
          // outcome rather than eagerly resolving/rejecting a promise no
          // consumer has attached to — a rejected unclaimed promise (e.g. a
          // buffered encrypted payload with no key) would otherwise surface
          // as an unhandled rejection and crash the process. `claim()` builds
          // the consumer-facing promise on demand.
          let outcome:
            | { ok: true; value: T }
            | { ok: false; error: unknown }
            | undefined;
          const hydrated = withResolvers<void>();

          const claim = (): Promise<T> =>
            hydrated.promise
              .then(() => awaitEarlierDeliveries(ctx, eventIndex, ['wait']))
              .then(() => {
                barrier.markDelivered();
                if (outcome && !outcome.ok) {
                  throw outcome.error;
                }
                return (outcome as { ok: true; value: T }).value;
              });

          ctx.pendingDeliveries++;
          ctx.promiseQueue = ctx.promiseQueue.then(async () => {
            try {
              const payload = await hydrateStepReturnValue(
                event.eventData.payload,
                ctx.runId,
                ctx.encryptionKey,
                ctx.globalThis
              );
              outcome = { ok: true, value: payload as T };
            } catch (error) {
              outcome = { ok: false, error };
            } finally {
              ctx.pendingDeliveries--;
              hydrated.resolve();
            }
          });
          payloadsQueue.push({ claim });
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

      // This replay installed a different consumer than the stored event needs.
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new ReplayDivergenceError(
            `Replay divergence: Unexpected event type for hook ${correlationId} (token: ${token}) "${event.eventType}"`,
            { eventId: event.eventId }
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
          // The payload was hydrated through a promiseQueue slot at its log
          // position (buffering branch above). `claim()` builds the
          // consumer-facing promise from that outcome, deferring behind any
          // earlier-in-log wait and marking this hook delivered — so
          // resolution order stays anchored to the event log, not this later
          // claim site.
          return nextDelivery.claim();
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
