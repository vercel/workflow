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

// Registry for class constructors that can be serialized
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
const registeredClasses = new Map<string, Function>();
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
const classToIdMap = new WeakMap<Function, string>();

/**
 * Register a class constructor for serialization.
 * This allows class constructors to be serialized as references and
 * restored during deserialization (e.g., when used as `this` in static method calls).
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function registerSerializationClass(classId: string, cls: Function) {
  registeredClasses.set(classId, cls);
  classToIdMap.set(cls, classId);
}

/**
 * Find a registered class constructor by ID
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function getSerializationClass(classId: string): Function | undefined {
  return registeredClasses.get(classId);
}

/**
 * Get the class ID for a registered class constructor
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function getSerializationClassId(cls: Function): string | undefined {
  return classToIdMap.get(cls);
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
