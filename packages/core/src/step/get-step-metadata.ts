import { contextStorage } from './context-storage.js';

export interface StepMetadata {
  /**
   * Unique identifier for the currently executing step.
   * Useful to use as part of an idempotency key for critical
   * operations that must only be executed once (such as charging a customer).
   *
   * @remarks
   *
   * Only available inside a step function.
   * Accessing this property in a workflow function will throw an error.
   */
  stepId: string;

  /**
   * Timestamp when the current step started.
   *
   * @remarks
   *
   * Only available inside a step function.
   * Accessing this property in a workflow function will throw an error.
   */
  stepStartedAt: Date;

  /**
   * The number of times the current step has been executed. This will increase with each retry.
   *
   * @remarks
   *
   * Only available inside a step function.
   * Accessing this property in a workflow function will throw an error.
   */
  attempt: number;
}

/**
 * Returns metadata available in the current step function.
 * It uses `AsyncLocalStorage` to store the context and
 * retrieve it in the step function.
 */
export function getStepMetadata(): StepMetadata {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      '`getStepMetadata()` can only be called inside a step function'
    );
  }
  return ctx.stepMetadata;
}
