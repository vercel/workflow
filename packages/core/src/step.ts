import { FatalError, WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { EventConsumerResult } from './events-consumer.js';
import { type StepInvocationQueueItem, WorkflowSuspension } from './global.js';
import { stepLogger } from './logger.js';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from './private.js';
import type { Serializable } from './schemas.js';
import { hydrateStepReturnValue } from './serialization.js';

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
          scheduleWhenIdle(ctx, () => {
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
                new WorkflowRuntimeError(
                  `Corrupted event log: step ${correlationId} (${stepName}) created but not found in invocation queue`
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
          // Step was started - don't do anything. The step is left in the invocationQueue which
          // will allow it to be re-enqueued. We rely on the queue's idempotency to prevent it from
          // actually being over enqueued.
          return EventConsumerResult.Consumed;
        }

        if (event.eventType === 'step_retrying') {
          // Step is being retried - just consume the event and wait for next step_started
          return EventConsumerResult.Consumed;
        }

        if (event.eventType === 'step_failed') {
          // Terminal state - we can remove the invocationQueue item
          ctx.invocationsQueue.delete(event.correlationId);
          // Step failed - chain through promiseQueue to ensure
          // deterministic ordering of all promise resolutions/rejections.
          ctx.promiseQueue = ctx.promiseQueue.then(() => {
            const errorData = event.eventData.error;
            const isErrorObject =
              typeof errorData === 'object' && errorData !== null;

            const errorMessage = isErrorObject
              ? (errorData.message ?? 'Unknown error')
              : typeof errorData === 'string'
                ? errorData
                : 'Unknown error';

            const errorStack =
              (isErrorObject ? errorData.stack : undefined) ??
              event.eventData.stack;

            const error = new FatalError(errorMessage);
            if (errorStack) {
              error.stack = errorStack;
            }
            reject(error);
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
          ctx.pendingDeliveries++;
          ctx.promiseQueue = ctx.promiseQueue.then(async () => {
            try {
              const hydratedResult = await hydrateStepReturnValue(
                event.eventData.result,
                ctx.runId,
                ctx.encryptionKey,
                ctx.globalThis
              );
              resolve(hydratedResult as Result);
            } catch (error) {
              reject(error);
            } finally {
              ctx.pendingDeliveries--;
            }
          });
          return EventConsumerResult.Finished;
        }

        // An unexpected event type has been received, this event log looks corrupted. Let's fail immediately.
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(
            new WorkflowRuntimeError(
              `Unexpected event type for step ${correlationId} (name: ${stepName}) "${event.eventType}"`
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

    // Store the closure variables function for serialization
    if (closureVarsFn) {
      Object.defineProperty(stepFunction, '__closureVarsFn', {
        value: closureVarsFn,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }

    return stepFunction;
  };
}
