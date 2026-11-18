/**
 * Reducers and revivers for custom class serialization.
 *
 * Handles:
 * - Class: class constructors with a `classId` property
 * - Instance: instances of classes with custom WORKFLOW_SERIALIZE/DESERIALIZE methods
 */

import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { getSerializationClass } from '../../class-serialization.js';
import { readProperty, recordGuestCode } from '../hardened.js';
import type { Reducers, Revivers } from '../types.js';

// ---- Call-site serialization ----

const callSiteOriginals = new WeakMap<object, object>();

class CallSiteSerializationFailure {
  constructor(readonly error: unknown) {}
}

/**
 * A custom-class instance already reduced to `{ classId, data }` by
 * {@link serializeInstanceAtCallSite}. A host object, so encoding it executes
 * no workflow code.
 */
class CallSiteSerializedInstance {
  constructor(
    readonly classId: string,
    readonly data: unknown,
    original: object
  ) {
    callSiteOriginals.set(this, original);
  }
}

/** Keep references to a stand-in and its original on the same wire index. */
export function callSiteInstanceIdentity(value: unknown): unknown {
  return value !== null && typeof value === 'object'
    ? (callSiteOriginals.get(value) ?? value)
    : value;
}

/**
 * Runs a step argument's custom `[WORKFLOW_SERIALIZE]` at the step call site,
 * inside the workflow body, and returns a host-side stand-in for it.
 *
 * Dehydrating step input happens after suspension, off the replayed path: a
 * serializer run there executes workflow code a cold replay would never
 * re-execute, so it would force the retained VM to be discarded
 * (`serialization_executed_workflow_code`) at every boundary — one full replay
 * per step for an agent loop that hands its model to a step each iteration
 * (vercel/workflow#4316). Run from the call site, the serializer executes on
 * every pass, retained or cold, so whatever it does to workflow state is
 * reconstructed by replay and the boundary stays retainable.
 *
 * Anything that is not a custom-serialized instance with a valid `classId` is
 * returned unchanged. Failures are deferred to dehydration without invoking
 * the failing serializer or property accessor a second time.
 */
export function serializeInstanceAtCallSite(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  try {
    const cls = readProperty(value, 'constructor');
    if (!cls || typeof cls !== 'function') return value;
    const serialize = readProperty(cls, WORKFLOW_SERIALIZE);
    if (typeof serialize !== 'function') return value;
    const classId = readProperty(cls, 'classId');
    if (typeof classId !== 'string') return value;
    const data = serialize.call(cls, value);
    return new CallSiteSerializedInstance(classId, data, value);
  } catch (error) {
    return new CallSiteSerializationFailure(error);
  }
}

// ---- Reducers ----

export function getClassReducers(): Partial<Reducers> {
  return {
    // Class and Instance are intentionally placed before Error so that
    // custom Error subclasses with WORKFLOW_SERIALIZE take precedence
    // over the generic Error serialization (devalue uses first-match-wins).
    Class: (value) => {
      if (typeof value !== 'function') return false;
      const classId = readProperty(value, 'classId');
      if (typeof classId !== 'string') return false;
      return { classId };
    },
    Instance: (value) => {
      if (value === null || typeof value !== 'object') return false;
      if (value instanceof CallSiteSerializationFailure) throw value.error;
      if (value instanceof CallSiteSerializedInstance) {
        return { classId: value.classId, data: value.data };
      }
      const cls = readProperty(value, 'constructor');
      if (!cls || typeof cls !== 'function') return false;

      const serialize = readProperty(cls, WORKFLOW_SERIALIZE);
      if (typeof serialize !== 'function') return false;

      const classId = readProperty(cls, 'classId');
      if (typeof classId !== 'string') {
        throw new Error(
          `Class "${String(readProperty(cls, 'name'))}" with ${String(WORKFLOW_SERIALIZE)} must have a static "classId" property.`
        );
      }

      // Custom serializers are workflow code by definition: the data only
      // exists behind them. Record the execution so retention-aware callers
      // can account for possible VM-state perturbation.
      recordGuestCode('method', `[WORKFLOW_SERIALIZE] (${classId})`);
      const data = serialize.call(cls, value);
      return { classId, data };
    },
  };
}

// ---- Revivers ----

export function getClassRevivers(
  global: Record<string, any> = globalThis
): Partial<Revivers> {
  return {
    Class: (value) => {
      const classId = value.classId;
      const cls = getSerializationClass(classId, global);
      if (!cls) {
        throw new Error(
          `Class "${classId}" not found. Make sure the class is registered with registerSerializationClass.`
        );
      }
      return cls;
    },
    Instance: (value) => {
      const classId = value.classId;
      const data = value.data;

      const cls = getSerializationClass(classId, global);
      if (!cls) {
        throw new Error(
          `Class "${classId}" not found. Make sure the class is registered with registerSerializationClass.`
        );
      }

      const deserialize = (cls as any)[WORKFLOW_DESERIALIZE];
      if (typeof deserialize !== 'function') {
        throw new Error(
          `Class "${classId}" does not have a static ${String(WORKFLOW_DESERIALIZE)} method.`
        );
      }

      return deserialize.call(cls, data);
    },
  };
}
