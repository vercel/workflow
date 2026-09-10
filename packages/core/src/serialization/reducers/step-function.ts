/**
 * Reducer and reviver for step function references.
 *
 * In workflow mode, step functions are replaced by the SWC plugin with
 * proxies created by `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("stepId")`.
 * These proxies have a `.stepId` property and optionally a `.__closureVarsFn`
 * for captured closure variables. They may additionally have `.__boundThis`
 * (and rarely `.__boundArgs`) when the SWC plugin emitted
 * `useStep(...).bind(this)` for a nested arrow step that lexically
 * captured `this` (see `packages/swc-plugin-workflow/spec.md` → "Lexical
 * `this` Capture in Nested Arrow Steps").
 *
 * The reducer serializes them as
 *   `{ stepId, closureVars?, boundThis?, boundArgs? }`.
 * The reviver reconstructs them by calling WORKFLOW_USE_STEP and, when
 * `boundThis` (or `boundArgs`) is present, re-binding the resulting
 * proxy so the caller's captured `this` (and prefilled args) survive the
 * round trip.
 */

import {
  hasProperty,
  isUseStepClosureFn,
  readProperty,
  recordGuestCode,
} from '../hardened.js';
import type { Reducers, Revivers } from '../types.js';

// ---- Reducer ----

export function getStepFunctionReducer(): Partial<Reducers> {
  return {
    StepFunction: (value) => {
      if (typeof value !== 'function') return false;
      const stepId = readProperty(value, 'stepId');
      if (typeof stepId !== 'string') return false;

      const closureVarsFn = readProperty(value, '__closureVarsFn');
      // The reducer has to invoke this to read the step's captured closure
      // variables. The compiler-generated function is a sequence of lexical
      // reads and cannot perturb observable VM state, so reporting it would
      // flag every step that captures a variable. But the property is
      // reachable from workflow code, which can replace it with anything.
      // `step.ts` marks the function that came through `useStep` when it
      // builds the proxy, so this is checked rather than assumed; anything
      // unrecognized is reported like other guest code. See
      // `markUseStepClosureFn` for what the mark does and does not prove.
      let closureVars: Record<string, unknown> | undefined;
      if (typeof closureVarsFn === 'function') {
        if (!isUseStepClosureFn(closureVarsFn)) {
          recordGuestCode('method', '__closureVarsFn');
        }
        closureVars = (closureVarsFn as () => Record<string, unknown>)();
      }

      // `__boundThis` / `__boundArgs` are marker properties added by the
      // step proxy's overridden `.bind` (see step.ts) to record the
      // bound receiver and any prefilled arguments. Use `in` for
      // `__boundThis` so we round-trip even when the bound `this` is
      // `undefined`/`null`. `__boundArgs` is only set when the user
      // actually supplied prefilled args, so a missing property means
      // "no prefilled args".
      const hasBoundThis = hasProperty(value, '__boundThis');
      const boundThis = hasBoundThis
        ? readProperty(value, '__boundThis')
        : undefined;
      const boundArgs = readProperty(value, '__boundArgs') as
        | unknown[]
        | undefined;

      const payload: {
        stepId: string;
        closureVars?: Record<string, any>;
        boundThis?: unknown;
        boundArgs?: unknown[];
      } = { stepId };
      if (closureVars !== undefined) payload.closureVars = closureVars;
      if (hasBoundThis) payload.boundThis = boundThis;
      if (Array.isArray(boundArgs) && boundArgs.length > 0) {
        payload.boundArgs = boundArgs;
      }

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
 * serialized payload includes `boundThis` (and optionally `boundArgs`),
 * the reviver also re-binds the freshly-created proxy so a step proxy
 * that was constructed with `.bind(this, …)` in the workflow bundle
 * continues to carry that receiver and any prefilled arguments after
 * being deserialized in another bundle (e.g. when passed as a step
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
        const boundArgs = Array.isArray(value.boundArgs) ? value.boundArgs : [];
        return (proxy as any).bind(value.boundThis, ...boundArgs);
      }
      return proxy;
    },
  };
}
