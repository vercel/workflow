/**
 * Utils used by the bundler when transforming code
 */

import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import type { Serializable } from './schemas.js';
import { WORKFLOW_STEP_REGISTRY } from './symbols.js';

export type StepFunction<
  Args extends Serializable[] = any[],
  Result extends Serializable | unknown = unknown,
> = ((...args: Args) => Promise<Result>) & {
  maxRetries?: number;
};

type StepRegistry = Map<string, StepFunction>;

/**
 * Get or create the step registry on the global object.
 * Using a global registry ensures that steps registered in bundled code
 * are accessible to stepEntrypoint even when it's imported from an external module.
 */
function getRegistry(): StepRegistry {
  const g = globalThis as any;
  let registry = g[WORKFLOW_STEP_REGISTRY] as StepRegistry | undefined;
  if (!registry) {
    registry = new Map();
    g[WORKFLOW_STEP_REGISTRY] = registry;
  }
  return registry;
}

/**
 * Register a step function to be served in the server bundle
 */
export function registerStepFunction(stepId: string, stepFn: StepFunction) {
  getRegistry().set(stepId, stepFn);
}

/**
 * Find a registered step function by name
 */
export function getStepFunction(stepId: string): StepFunction | undefined {
  return getRegistry().get(stepId);
}

/**
 * Get closure variables for the current step function
 * @internal
 */
export { __private_getClosureVars } from './step/get-closure-vars.js';

export interface WorkflowOrchestratorContext {
  globalThis: typeof globalThis;
  eventsConsumer: EventsConsumer;
  /**
   * Map of pending invocations keyed by correlationId.
   * Using Map instead of Array for O(1) lookup/delete operations.
   */
  invocationsQueue: Map<string, QueueItem>;
  onWorkflowError: (error: Error) => void;
  generateUlid: () => string;
  generateNanoid: () => string;
}
