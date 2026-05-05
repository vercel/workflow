/**
 * Reducer and reviver for step function references.
 *
 * In workflow mode, step functions are replaced by the SWC plugin with
 * proxies created by `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("stepId")`.
 * These proxies have a `.stepId` property and optionally a `.__closureVarsFn`
 * for captured closure variables. They may additionally have a
 * `.__boundThis` property when the SWC plugin emitted `useStep(...).bind(this)`
 * for a nested arrow step that lexically captured `this` (see
 * `packages/swc-plugin-workflow/spec.md` → "Lexical `this` Capture in
 * Nested Arrow Steps").
 *
 * The reducer serializes them as `{ stepId, closureVars?, boundThis? }`.
 * The reviver reconstructs them by calling WORKFLOW_USE_STEP and, when
 * `boundThis` is present, re-binding the resulting proxy so the caller's
 * captured `this` survives the round trip.
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
      const closureVars =
        closureVarsFn && typeof closureVarsFn === 'function'
          ? closureVarsFn()
          : undefined;

      // `__boundThis` is a marker property added by the step proxy's
      // overridden `.bind` (see step.ts) to record the captured lexical
      // `this`. Use `in` so we round-trip even when the bound `this` is
      // `undefined`/`null`.
      const hasBoundThis = '__boundThis' in (value as any);
      const boundThis = hasBoundThis ? (value as any).__boundThis : undefined;

      const payload: {
        stepId: string;
        closureVars?: Record<string, any>;
        boundThis?: unknown;
      } = { stepId };
      if (closureVars !== undefined) payload.closureVars = closureVars;
      if (hasBoundThis) payload.boundThis = boundThis;

      return payload;
    },
  };
}

// ---- Reviver ----

/**
 * Create the StepFunction reviver for workflow context.
 *
 * The reviver calls WORKFLOW_USE_STEP to create the step proxy,
 * restoring the ability to call the step from workflow code. If the
 * serialized payload includes `boundThis`, the reviver also re-binds the
 * freshly-created proxy so a step proxy that was constructed with
 * `.bind(this)` in the workflow bundle continues to carry that `this`
 * after being deserialized in another bundle (e.g. when passed as a step
 * argument).
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

      const proxy = closureVars
        ? useStep(stepId, () => closureVars)
        : useStep(stepId);

      if ('boundThis' in value) {
        return (proxy as any).bind(value.boundThis);
      }
      return proxy;
    },
  };
}
