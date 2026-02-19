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
  stepId?: string;
};

const registeredSteps = new Map<string, StepFunction>();

function getStepIdAliasCandidates(stepId: string): string[] {
  const parts = stepId.split('//');
  if (parts.length !== 3 || parts[0] !== 'step') {
    return [];
  }

  const modulePath = parts[1];
  const fnName = parts[2];
  const modulePathAliases = new Set<string>();

  const addAlias = (aliasModulePath: string) => {
    if (aliasModulePath !== modulePath) {
      modulePathAliases.add(aliasModulePath);
    }
  };

  if (modulePath.startsWith('./workflows/')) {
    const workflowRelativePath = modulePath.slice('./'.length);
    addAlias(`./example/${workflowRelativePath}`);
    addAlias(`./src/${workflowRelativePath}`);
  } else if (modulePath.startsWith('./example/workflows/')) {
    const workflowRelativePath = modulePath.slice('./example/'.length);
    addAlias(`./${workflowRelativePath}`);
    addAlias(`./src/${workflowRelativePath}`);
  } else if (modulePath.startsWith('./src/workflows/')) {
    const workflowRelativePath = modulePath.slice('./src/'.length);
    addAlias(`./${workflowRelativePath}`);
    addAlias(`./example/${workflowRelativePath}`);
  }

  return Array.from(
    modulePathAliases,
    (aliasModulePath) => `step//${aliasModulePath}//${fnName}`
  );
}

/**
 * Register a step function to be served in the server bundle.
 * Also sets the stepId property on the function for serialization support.
 */
export function registerStepFunction(stepId: string, stepFn: StepFunction) {
  registeredSteps.set(stepId, stepFn);
  stepFn.stepId = stepId;
}

/**
 * Find a registered step function by name
 */
export function getStepFunction(stepId: string): StepFunction | undefined {
  const directMatch = registeredSteps.get(stepId);
  if (directMatch) {
    return directMatch;
  }

  // Support equivalent workflow path aliases in mixed symlink environments.
  for (const aliasStepId of getStepIdAliasCandidates(stepId)) {
    const aliasMatch = registeredSteps.get(aliasStepId);
    if (aliasMatch) {
      return aliasMatch;
    }
  }

  return undefined;
}

/**
 * Get closure variables for the current step function
 * @internal
 */
export { __private_getClosureVars } from './step/get-closure-vars.js';

export interface WorkflowOrchestratorContext {
  runId: string;
  encryptionKey: Uint8Array | undefined;
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
