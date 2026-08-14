import { FatalError, ReplayDivergenceError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { EventConsumerResult } from './events-consumer.js';
import { type StepInvocationQueueItem, WorkflowSuspension } from './global.js';
import { stepLogger } from './logger.js';
import {
  awaitEarlierDeliveries,
  registerDeliveryBarrier,
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from './private.js';
import type { Serializable } from './schemas.js';
import { markUseStepClosureFn } from './serialization/hardened.js';
import { hydrateStepError, hydrateStepReturnValue } from './serialization.js';

export function createUseStep(ctx: WorkflowOrchestratorContext) {
  return function useStep<Args extends Serializable[], Result>(
    stepName: string,
    closureVarsFn?: () => Record<string, Serializable>
  ) {
    // Use a regular function (not arrow) so we can capture `this` when invoked as a method
    const stepFunction = function (
      this: unknown,
      ...args: Args
    ): Promise<Result> {
      const { promise, resolve, reject } = withResolvers<Result>();

      const correlationId = `step_${ctx.generateUlid()}`;

      const queueItem: StepInvocationQueueItem = {
        type: 'step',
        correlationId,
        stepName,
        args,
      };

      // Capture `this` value for method invocations (e.g., MyClass.method())
      // Only include if `this` is defined and not the global object
      if (this !== undefined && this !== null && this !== globalThis) {
        queueItem.thisVal = this as Serializable;
      }

      // Invoke the closure variables function to get the closure scope
      const closureVars = closureVarsFn?.();
      if (closureVars) {
        queueItem.closureVars = closureVars;
      }

      ctx.invocationsQueue.set(correlationId, queueItem);

      stepLogger.debug('Step consumer setup', {
        correlationId,
        stepName,
        args,
      });
      ctx.eventsConsumer.subscribe((event) => {
        if (!event) {
          // We've reached the end of the events, so this step has either not been run or is currently running.
          // Crucially, if we got here, then this step Promise does
          // not resolve so that the user workflow code does not proceed any further.
          // Notify the workflow handler that this step has not been run / has not completed yet.
          const generation = ctx.suspensionGeneration;
          scheduleWhenIdle(ctx, () => {
            // A retained session may have resumed past this boundary while
            // the timer was queued; a stale signal must not fire.
            if (generation !== ctx.suspensionGeneration) return;
            ctx.onWorkflowError(
              new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
            );
          });
          return EventConsumerResult.NotConsumed;
        }

        stepLogger.debug('Step consumer event processing', {
          correlationId,
          stepName,
          args: args.join(', '),
          incomingCorrelationId: event.correlationId,
          isMatch: correlationId === event.correlationId,
          eventType: event.eventType,
        });

        if (event.correlationId !== correlationId) {
          // We're not interested in this event - the correlationId belongs to a different entity
          return EventConsumerResult.NotConsumed;
        }

        const eventStepName =
          'eventData' in event &&
          event.eventData &&
          'stepName' in event.eventData
            ? event.eventData.stepName
            : undefined;

        if (typeof eventStepName === 'string' && eventStepName !== stepName) {
          ctx.promiseQueue = ctx.promiseQueue.then(() => {
            ctx.onWorkflowError(
              new ReplayDivergenceError(
                `Replay divergence: step event ${event.eventType} for ${correlationId} belongs to "${eventStepName}", but the current step consumer is "${stepName}"`,
                { eventId: event.eventId }
              )
            );
          });
          return EventConsumerResult.Finished;
        }

        if (event.eventType === 'step_created') {
          // Step has been created (registered for execution) - mark as having event
          // but keep in queue so suspension handler knows to queue execution without
          // creating a duplicate step_created event
          const queueItem = ctx.invocationsQueue.get(correlationId);
          if (!queueItem || queueItem.type !== 'step') {
            // This indicates event log corruption - step_created received
            // but the step was never invoked in the workflow during replay.
            ctx.promiseQueue = ctx.promiseQueue.then(() => {
              reject(
                new ReplayDivergenceError(
                  `Replay divergence: step ${correlationId} (${stepName}) created but not found in invocation queue`,
                  { eventId: event.eventId }
                )
              );
            });
            return EventConsumerResult.Finished;
          }
          queueItem.hasCreatedEvent = true;
          // Continue waiting for step_started/step_completed/step_failed events
          return EventConsumerResult.Consumed;
        }

        if (event.eventType === 'step_started') {
          // Step was started but is not terminal — it stays in the
          // invocationQueue so the suspension handler can decide how to
          // dispatch it. Record the inline-ownership state from the event:
          // the LATEST start wins, so a stamped start (inline execution or
          // owner recovery) sets the owner and an unstamped one (a retry
          // attempt driven by a queued step message, or an older runtime)
          // clears it. The dispatch loop uses this to suppress the immediate
          // requeue of a step whose owning invocation may still be running
          // its body (vercel/workflow#2780).
          const queueItem = ctx.invocationsQueue.get(correlationId);
          if (queueItem && queueItem.type === 'step') {
            const ownerMessageId =
              'eventData' in event &&
              event.eventData &&
              'ownerMessageId' in event.eventData &&
              typeof event.eventData.ownerMessageId === 'string'
                ? event.eventData.ownerMessageId
                : undefined;
            queueItem.ownerMessageId = ownerMessageId;
            queueItem.lastStartedAt = +event.createdAt;
          }
          return EventConsumerResult.Consumed;
        }

        if (event.eventType === 'step_retrying') {
          // Step is being retried — consume the event and wait for the next
          // step_started. From here on the step is queue-owned (the delayed
          // retry handoff message, or the replay requeue), so inline
          // ownership is permanently lapsed for this correlation ID.
          const queueItem = ctx.invocationsQueue.get(correlationId);
          if (queueItem && queueItem.type === 'step') {
            queueItem.sawRetrying = true;
            queueItem.ownerMessageId = undefined;
          }
          return EventConsumerResult.Consumed;
        }

        if (event.eventType === 'step_failed') {
          // Terminal state - we can remove the invocationQueue item
          ctx.invocationsQueue.delete(event.correlationId);
          // Step failed - chain through promiseQueue to ensure
          // deterministic ordering of all promise resolutions/rejections.
          // Hydrate the serialized thrown value from the event log so the
          // original type identity and custom properties are preserved.
          //
          // The rejection is as branch-deciding as a success: it decides
          // whether a `try`/`catch` continuation runs, and therefore which
          // ULIDs the follow-up `useStep` calls draw. So it is ordered by
          // event-log position exactly like `step_completed` below — see there
          // for why the deferral is captured here, at event-consumption time,
          // and awaited off the serial queue.
          const eventIndex = ctx.eventsConsumer.eventIndex;
          const barrier = registerDeliveryBarrier(ctx, eventIndex, 'step');
          let rejection: unknown;
          const earlierDelivered = awaitEarlierDeliveries(
            ctx,
            eventIndex,
            'step'
          );
          ctx.pendingDeliveries++;
          ctx.promiseQueue = ctx.promiseQueue.then(async () => {
            try {
              rejection = await ctx.replayPayloadCache.getEventValue(
                event.eventId,
                event.eventData.error,
                (prepared) =>
                  hydrateStepError(
                    event.eventData.error,
                    ctx.runId,
                    ctx.encryptionKey,
                    ctx.globalThis,
                    {},
                    prepared
                  )
              );
            } catch (hydrateErr) {
              // If hydration fails for any reason, fall back to a generic
              // FatalError so the workflow doesn't hang. This should be
              // extremely rare in practice (corrupted event data).
              stepLogger.error('Failed to hydrate step_failed error', {
                correlationId: event.correlationId,
                error:
                  hydrateErr instanceof Error
                    ? hydrateErr.message
                    : String(hydrateErr),
              });
              rejection = new FatalError(
                `Failed to hydrate step error: ${
                  hydrateErr instanceof Error
                    ? hydrateErr.message
                    : String(hydrateErr)
                }`
              );
            } finally {
              ctx.pendingDeliveries--;
            }
            void earlierDelivered.then(() => {
              barrier.markDelivered();
              reject(rejection);
            });
          });
          return EventConsumerResult.Finished;
        }

        if (event.eventType === 'step_completed') {
          // Terminal state - we can remove the invocationQueue item
          ctx.invocationsQueue.delete(event.correlationId);

          // Step has completed, so resolve the Promise with the cached result.
          // The hydration is async (e.g., decryption), so we chain it through
          // ctx.promiseQueue to ensure that even if deserialization
          // takes variable time, promises resolve in event log order.
          // Each step's hydration + resolve waits for all prior hydrations
          // to complete before executing, preserving deterministic ordering.
          //
          // Prepared serialized bytes are shared across replay VMs, but final
          // objects are always revived here inside this ordered queue slot.
          // Only immutable primitive final values bypass revival entirely.
          //
          // Hydration cost is what makes this delivery's timing unstable
          // across replays of one invocation: the first replay pays the full
          // decrypt/decompress/revive, later replays memo-hit a primitive
          // result in `ReplayPayloadCache` and finish in a hop or two. A
          // workflow awaiting this result on one branch and a `sleep()` or
          // hook payload on another would therefore allocate its follow-up
          // step ULIDs in a different order on a warm replay than the
          // invocation that WROTE those `step_created` events did — a
          // permanent `ReplayDivergenceError`. So the result is ordered by
          // event-log position through the delivery-barrier registry (see
          // `ctx.pendingDeliveryBarriers`):
          //  - Register a 'step' barrier at this event's index so a
          //    LATER-in-log wait/hook delivery is handed over only after it.
          //  - Hydrate inside this serial queue slot (keeping async
          //    deserialization in event-log order) but only CAPTURE the
          //    outcome; then defer behind every EARLIER-in-log wait and hook
          //    delivery before resolving, and mark this step delivered.
          //
          // The deferral is captured HERE, while consuming the event, and not
          // inside the queue slot. Two reasons, both load-bearing:
          //  - Determinism: the set of earlier deliveries is then a function of
          //    log position alone. Captured later it would depend on how much
          //    hydration the earlier deliveries had already finished — the very
          //    coupling this barrier exists to remove.
          //  - Coverage: an earlier delivery whose own hydration slot runs
          //    first on this serial queue has usually already resolved (and so
          //    deregistered its barrier) by the time a later slot starts. Read
          //    at slot start, its barrier would be invisible and this step
          //    would not defer at all. Every event in one drain window is
          //    consumed before any slot runs, so capturing at consumption time
          //    sees all of them.
          //
          // The deferral runs OFF the serial queue: it may wait on an earlier
          // wait/hook delivery whose own resolution is driven by this queue,
          // and blocking a queue slot on that would deadlock the queue (the
          // same constraint sleep.ts and hook.ts document). `pendingDeliveries`
          // is likewise released inside the slot, before the detached defer, so
          // `scheduleWhenIdle` can still reach idle and retire the barriers
          // this deferral may be waiting on.
          const completedEventId = event.eventId;
          const serializedResult = event.eventData.result;
          const eventIndex = ctx.eventsConsumer.eventIndex;
          const barrier = registerDeliveryBarrier(ctx, eventIndex, 'step');
          let outcome:
            | { ok: true; value: Result }
            | { ok: false; error: unknown };
          const earlierDelivered = awaitEarlierDeliveries(
            ctx,
            eventIndex,
            'step'
          );
          ctx.pendingDeliveries++;
          ctx.promiseQueue = ctx.promiseQueue.then(async () => {
            try {
              const hydratedResult = await ctx.replayPayloadCache.getEventValue(
                completedEventId,
                serializedResult,
                (prepared) =>
                  hydrateStepReturnValue(
                    serializedResult,
                    ctx.runId,
                    ctx.encryptionKey,
                    ctx.globalThis,
                    {},
                    prepared
                  )
              );
              outcome = { ok: true, value: hydratedResult as Result };
            } catch (error) {
              outcome = { ok: false, error };
            } finally {
              ctx.pendingDeliveries--;
            }
            void earlierDelivered.then(() => {
              barrier.markDelivered();
              if (outcome.ok) {
                resolve(outcome.value);
              } else {
                reject(outcome.error);
              }
            });
          });
          return EventConsumerResult.Finished;
        }

        // This replay installed a different consumer than the stored event needs.
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(
            new ReplayDivergenceError(
              `Replay divergence: Unexpected event type for step ${correlationId} (name: ${stepName}) "${event.eventType}"`,
              { eventId: event.eventId }
            )
          );
        });
        return EventConsumerResult.Finished;
      });

      return promise;
    };

    // Ensure the "name" property matches the original step function name
    // Extract function name from stepName (format: "step//filepath//functionName")
    const functionName = stepName.split('//').pop();
    Object.defineProperty(stepFunction, 'name', {
      value: functionName,
    });

    // Add the step function identifier to the step function for serialization
    Object.defineProperty(stepFunction, 'stepId', {
      value: stepName,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Store the closure variables function for serialization. Mark it so the
    // step-function reducer can tell a function that came through `useStep`
    // apart from one workflow code assigned over the property afterwards —
    // the reducer has to invoke whatever is there, and only the latter is
    // worth reporting. See `markUseStepClosureFn` for the limits of what
    // this proves.
    if (closureVarsFn) {
      markUseStepClosureFn(closureVarsFn);
      Object.defineProperty(stepFunction, '__closureVarsFn', {
        value: closureVarsFn,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }

    // Override `.bind` so the bound function preserves the step proxy
    // metadata that `getStepFunctionReducer` relies on for serialization.
    // Without this override, `Function.prototype.bind` would return a new
    // function that doesn't inherit `stepId`, `__closureVarsFn`, or any
    // other own properties of the original proxy — so the StepFunction
    // reducer would refuse to serialize it (it'd look like a plain
    // function), and a `useStep(...).bind(this)` proxy that flowed
    // through workflow serialization would silently break.
    //
    // The override stashes three pieces of state on the bound function so
    // the round trip is faithful:
    //   - `stepId`             — already set on the original proxy.
    //   - `__closureVarsFn`    — only when the original proxy had one.
    //   - `__boundThis`        — the receiver passed to `.bind(thisArg, …)`.
    //                            Always set (even when `thisArg` is
    //                            `null`/`undefined`) so the reducer can
    //                            distinguish "was bound" from "wasn't".
    //   - `__boundArgs`        — only when the user supplied prefilled
    //                            arguments (`.bind(thisArg, x, y)`). The
    //                            SWC plugin only ever emits `.bind(this)`
    //                            today, so this is rare in practice; we
    //                            still capture it so the partial args
    //                            survive serialization rather than
    //                            silently disappearing on the step side.
    Object.defineProperty(stepFunction, 'bind', {
      value: function (
        this: typeof stepFunction,
        thisArg: unknown,
        ...partialArgs: unknown[]
      ) {
        const bound = Function.prototype.bind.call(
          this,
          thisArg,
          ...partialArgs
        );
        Object.defineProperty(bound, 'stepId', {
          value: stepName,
          writable: false,
          enumerable: false,
          configurable: false,
        });
        if (closureVarsFn) {
          Object.defineProperty(bound, '__closureVarsFn', {
            value: closureVarsFn,
            writable: false,
            enumerable: false,
            configurable: false,
          });
        }
        Object.defineProperty(bound, '__boundThis', {
          value: thisArg,
          writable: false,
          enumerable: false,
          configurable: false,
        });
        if (partialArgs.length > 0) {
          Object.defineProperty(bound, '__boundArgs', {
            value: partialArgs,
            writable: false,
            enumerable: false,
            configurable: false,
          });
        }
        return bound;
      },
      writable: false,
      enumerable: false,
      configurable: false,
    });

    return stepFunction;
  };
}
