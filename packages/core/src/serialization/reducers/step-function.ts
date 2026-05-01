/**
 * Reducer and reviver for step function references.
 *
 * In workflow mode, step functions are replaced by the SWC plugin with
 * proxies created by `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("stepId")`.
 * These proxies have a `.stepId` property and optionally a `.__closureVarsFn`
 * for captured closure variables.
 *
 * The reducer serializes them as `{ stepId, closureVars? }`.
 * The reviver reconstructs them by calling WORKFLOW_USE_STEP.
 */

import type { Reducers, Revivers } from '../types.js';

// ---- Reducer ----

export function getStepFunctionReducer(): Partial<Reducers> {
  return {
    StepFunction: (value) => {
      if (typeof value !== 'function') return false;
      const stepId = (value as any).stepId;
      if (typeof stepId !== 'string') return false;

      const closureVarsFn = (value as any).__closureVarsFn;
      if (closureVarsFn && typeof closureVarsFn === 'function') {
        const closureVars = closureVarsFn();
        return { stepId, closureVars };
      }

      return { stepId };
    },
  };
}

// ---- Reviver ----

/**
 * Create the StepFunction reviver for workflow context.
 *
 * The reviver calls WORKFLOW_USE_STEP to create the step proxy,
 * restoring the ability to call the step from workflow code.
 */
export function getStepFunctionReviver(
  global: Record<string, any> = globalThis
): Partial<Revivers> {
  const useStep = (global as any)[Symbol.for('WORKFLOW_USE_STEP')] as
    | ((
        stepId: string,
        closureVarsFn?: () => Record<string, unknown>
      ) => (...args: unknown[]) => Promise<unknown>)
    | undefined;

  return {
    StepFunction: (value) => {
      const stepId = value.stepId;
      const closureVars = value.closureVars;

      if (!useStep) {
        throw new Error(
          'WORKFLOW_USE_STEP not found on global object. Step functions cannot be deserialized outside workflow context.'
        );
      }

      if (closureVars) {
        return useStep(stepId, () => closureVars);
      }
      return useStep(stepId);
    },
  };
}
