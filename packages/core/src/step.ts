import { FatalError, WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { EventConsumerResult } from './events-consumer.js';
import { type StepInvocationQueueItem, WorkflowSuspension } from './global.js';
import { stepLogger } from './logger.js';
import type { WorkflowOrchestratorContext } from './private.js';
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

      // Track whether we've already seen a "step_started" event for this step.
      // This is important because after a retryable failure, the step moves back to
      // "pending" status which causes another "step_started" event to be emitted.
      let hasSeenStepStarted = false;

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
          setTimeout(() => {
            ctx.onWorkflowError(
              new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
            );
          }, 0);
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
          // We're not interested in this event - the correlationId belongs to a different step
          return EventConsumerResult.NotConsumed;
        }

        if (event.eventType === 'step_started') {
          // Step has started - so remove from the invocations queue (only on the first "step_started" event)
          if (!hasSeenStepStarted) {
            // O(1) lookup and delete using Map
            if (ctx.invocationsQueue.has(correlationId)) {
              ctx.invocationsQueue.delete(correlationId);
            } else {
              setTimeout(() => {
                reject(
                  new WorkflowRuntimeError(
                    `Corrupted event log: step ${correlationId} (${stepName}) started but not found in invocation queue`
                  )
                );
              }, 0);
              return EventConsumerResult.Finished;
            }
            hasSeenStepStarted = true;
          }
          // If this is a subsequent "step_started" event (after a retry), we just consume it
          // without trying to remove from the queue again or logging a warning
          return EventConsumerResult.Consumed;
        }

        if (event.eventType === 'step_failed') {
          // Step failed - bubble up to workflow
          if (event.eventData.fatal) {
            setTimeout(() => {
              const error = new FatalError(event.eventData.error);
              // Preserve the original stack trace from the step execution
              // This ensures that deeply nested errors show the full call chain
              if (event.eventData.stack) {
                error.stack = event.eventData.stack;
              }
              reject(error);
            }, 0);
            return EventConsumerResult.Finished;
          } else {
            // This is a retryable error, so nothing to do here,
            // but we will consume the event
            return EventConsumerResult.Consumed;
          }
        } else if (event.eventType === 'step_completed') {
          // Step has already completed, so resolve the Promise with the cached result
          const hydratedResult = hydrateStepReturnValue(
            event.eventData.result,
            ctx.globalThis
          );
          setTimeout(() => {
            resolve(hydratedResult);
          }, 0);
          return EventConsumerResult.Finished;
        } else {
          // An unexpected event type has been received, but it does belong to this step (matching `correlationId`)
          setTimeout(() => {
            reject(
              new WorkflowRuntimeError(
                `Unexpected event type: "${event.eventType}"`
              )
            );
          }, 0);
          return EventConsumerResult.Finished;
        }
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
