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

/**
 * The shape resolved by `hook.getConflict()` when another active hook
 * owns the token: a plain `{ runId }` object identifying the owning run.
 * To act on the owner — inspect its status, await its result, or cancel
 * it — the workflow passes `conflict.runId` to `getRun()` inside a step.
 */
type ConflictingRun = { runId: string };

/**
 * Constructs the `{ runId }` handle for the run that owns a conflicting
 * hook token, for resolution through `hook.getConflict()`.
 *
 * Returns `null` when the conflicting run cannot be identified: the
 * conflict event lacks `conflictingRunId` (written by an old world).
 * `getConflict` awaiters then reject with `HookConflictError` instead of
 * resolving with an incomplete value.
 */
function createConflictingRun(
  conflictingRunId: string | undefined
): ConflictingRun | null {
  if (typeof conflictingRunId !== 'string') {
    return null;
  }
  return { runId: conflictingRunId };
}

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

    // Queue of promises that resolve once hook registration is confirmed
    // (with `null`) or a token conflict is detected (with the conflicting
    // `{ runId }`). These back the `hook.getConflict()` method.
    const getConflictPromises: PromiseWithResolvers<ConflictingRun | null>[] =
      [];

    let eventLogEmpty = false;

    // Track if the event log confirms hook creation happened
    let hasCreated = false;

    // Track if the event log confirms disposal happened (replay no-op)
    let hasDisposedEvent = false;

    // Track if we have a conflict so we can reject future awaits
    let hasConflict = false;
    let conflictErrorRef: HookConflictError | null = null;
    // The conflicting run handle, shared by every `getConflict` await so
    // repeated awaits observe the same instance deterministically.
    let conflictRunRef: ConflictingRun | null = null;

    webhookLogger.debug('Hook consumer setup', { correlationId, token });
    ctx.eventsConsumer.subscribe((event) => {
      // If there are no events and there are promises waiting,
      // it means the hook has been awaited, but an incoming payload has not yet been received.
      // In this case, the workflow should be suspended until the hook is resumed.
      if (!event) {
        eventLogEmpty = true;

        if (
          (promises.length > 0 && payloadsQueue.length === 0) ||
          (getConflictPromises.length > 0 && !hasCreated && !hasConflict)
        ) {
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
        hasCreated = true;

        const pendingGetConflictPromises = getConflictPromises.slice();
        getConflictPromises.length = 0;
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          for (const resolver of pendingGetConflictPromises) {
            resolver.resolve(null);
          }
        });

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
        conflictRunRef = createConflictingRun(
          conflictEvent.eventData.conflictingRunId
        );

        // Capture and drain pending promises synchronously so the null event
        // handler won't see them and trigger a spurious WorkflowSuspension.
        // The actual settlements are deferred through promiseQueue for
        // ordering. Payload awaiters reject with HookConflictError, while
        // `getConflict` awaiters resolve with the conflicting `{ runId }`
        // so the workflow can branch on the conflict without throwing.
        // When the conflicting run cannot be identified (see
        // `createConflictingRun`), `getConflict` awaiters reject with the
        // HookConflictError instead of resolving with an incomplete value.
        const pendingPromises = promises.slice();
        promises.length = 0;
        const pendingGetConflictPromises = getConflictPromises.slice();
        getConflictPromises.length = 0;

        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          for (const resolver of pendingPromises) {
            resolver.reject(conflictError);
          }
          for (const resolver of pendingGetConflictPromises) {
            if (conflictRunRef) {
              resolver.resolve(conflictRunRef);
            } else {
              resolver.reject(conflictError);
            }
          }
        });

        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'hook_received') {
        // Register a 'hook' delivery barrier at this event's log index so a
        // later-in-log `wait_completed` or step result is delivered only after
        // this hook, and so this hook is delivered only after every
        // earlier-in-log `wait_completed` and step result — keeping any
        // `Promise.race` (or concurrent-branch ULID allocation) deterministic
        // and aligned with the committed event log, regardless of
        // microtask-hop count, hydration time, or race-argument order.
        // See `ctx.pendingDeliveryBarriers`.
        //
        // The barrier is registered ARMED only when a consumer is already
        // awaiting, so this payload is committed to reaching the workflow. A
        // buffered payload is registered unarmed and armed by `claim()`: until
        // a consumer takes it, a later step result must not be ordered behind
        // it (see `awaitEarlierDeliveries`).
        const eventIndex = ctx.eventsConsumer.eventIndex;
        const hasWaitingConsumer = promises.length > 0;
        const barrier = registerDeliveryBarrier(ctx, eventIndex, 'hook', {
          armed: hasWaitingConsumer,
        });

        if (hasWaitingConsumer) {
          // A consumer is already awaiting, so this payload's delivery is
          // pinned to this log position: capture the deferral HERE, while
          // consuming the event, not at the end of the hydration slot below —
          // same reasoning as step.ts. An earlier step or hook whose slot runs
          // first on this serial queue has usually delivered, and so
          // deregistered its barrier, before this slot ends. Read then, it
          // would be invisible and this payload would skip both the gate AND
          // `awaitEarlierDeliveries`' macrotask yield, letting it overtake the
          // branch that earlier delivery just woke. Every event in one drain
          // window is consumed before any slot runs, so capturing at
          // consumption time sees all of them.
          //
          // The BUFFERED branch below deliberately does NOT do this — see the
          // comment on `claim()`.
          const earlierDelivered = awaitEarlierDeliveries(
            ctx,
            eventIndex,
            'hook'
          );
          const next = promises.shift();
          if (next) {
            // Hydrate through a promiseQueue slot (so async deserialization
            // stays in event-log order), then defer behind earlier waits and
            // steps before resolving. The deferral runs OFF the serial queue
            // (it may wait on an earlier wait or step delivery and blocking a
            // queue slot on that would deadlock the queue).
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
              void earlierDelivered.then(() => {
                barrier.markDelivered();
                if (hydrateOutcome.ok) {
                  next.resolve(hydrateOutcome.value);
                } else {
                  next.reject(hydrateOutcome.error);
                }
              });
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

          const claim = (): Promise<T> => {
            // A consumer has taken this payload, so its delivery no longer
            // waits on workflow code: later step results may now be ordered
            // behind it.
            barrier.arm();
            // Unlike every other delivery, the deferral is evaluated HERE, at
            // claim time, rather than when the event was consumed. A buffered
            // payload's delivery genuinely happens when the workflow reads the
            // hook, which may be many deliveries later; a consumption-time
            // snapshot would make the claim wait on — and pay the macrotask
            // yield for — barriers that were relevant to a moment this payload
            // never participated in. That is not theoretical: it stalls the
            // second payload in the e2e `hookWithSleepWorkflow` long enough
            // for the run to suspend before delivering it.
            return hydrated.promise
              .then(() => awaitEarlierDeliveries(ctx, eventIndex, 'hook'))
              .then(() => {
                barrier.markDelivered();
                if (outcome && !outcome.ok) {
                  throw outcome.error;
                }
                return (outcome as { ok: true; value: T }).value;
              });
          };

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
          // earlier-in-log wait or step and marking this hook delivered — so
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

    // Helper function to create a promise that resolves with the hook's
    // registration outcome: the conflicting `{ runId }` when the token is
    // owned by another active hook, `null` once this hook's registration
    // is committed. Both fast-paths settle through `ctx.promiseQueue` so
    // resolution order always matches event-log order.
    function createGetConflictPromise(): Promise<ConflictingRun | null> {
      const resolvers = withResolvers<ConflictingRun | null>();

      if (hasCreated) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          resolvers.resolve(null);
        });
        return resolvers.promise;
      }

      if (hasConflict) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          if (conflictRunRef) {
            resolvers.resolve(conflictRunRef);
          } else {
            resolvers.reject(conflictErrorRef);
          }
        });
        return resolvers.promise;
      }

      const queueItem = ctx.invocationsQueue.get(correlationId);
      if (queueItem && queueItem.type === 'hook') {
        queueItem.hasConflictAwaiter = true;
      }

      if (eventLogEmpty) {
        scheduleWhenIdle(ctx, () => {
          ctx.onWorkflowError(
            new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
          );
        });
      }

      getConflictPromises.push(resolvers);
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

      getConflict(): Promise<ConflictingRun | null> {
        return createGetConflictPromise();
      },

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
