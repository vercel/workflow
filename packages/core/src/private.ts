/**
 * Utils used by the bundler when transforming code
 */

import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import type { Serializable } from './schemas.js';

export type StepFunction<
  Args extends Serializable[] = any[],
  Result extends Serializable | unknown = unknown,
> = ((...args: Args) => Promise<Result>) & {
  maxRetries?: number;
};

const registeredSteps = new Map<string, StepFunction>();

/**
 * Register a step function to be served in the server bundle
 */
export function registerStepFunction(stepId: string, stepFn: StepFunction) {
  registeredSteps.set(stepId, stepFn);
}

/**
 * Find a registered step function by name
 */
export function getStepFunction(stepId: string): StepFunction | undefined {
  return registeredSteps.get(stepId);
}

export interface WorkflowOrchestratorContext {
  globalThis: typeof globalThis;
  eventsConsumer: EventsConsumer;
  invocationsQueue: QueueItem[];
  onWorkflowError: (error: Error) => void;
  generateUlid: () => string;
  generateNanoid: () => string;
}
