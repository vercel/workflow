/**
 * Reducers and revivers for custom class serialization.
 *
 * Handles:
 * - Class: class constructors with a `classId` property
 * - Instance: instances of classes with custom WORKFLOW_SERIALIZE/DESERIALIZE methods
 */

import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { getSerializationClass } from '../../class-serialization.js';
import type { Reducers, Revivers } from '../types.js';

// ---- Reducers ----

export function getClassReducers(): Partial<Reducers> {
  return {
    // Class and Instance are intentionally placed before Error so that
    // custom Error subclasses with WORKFLOW_SERIALIZE take precedence
    // over the generic Error serialization (devalue uses first-match-wins).
    Class: (value) => {
      if (typeof value !== 'function') return false;
      const classId = (value as any).classId;
      if (typeof classId !== 'string') return false;
      return { classId };
    },
    Instance: (value) => {
      if (value === null || typeof value !== 'object') return false;
      const cls = value.constructor;
      if (!cls || typeof cls !== 'function') return false;

      const serialize = cls[WORKFLOW_SERIALIZE];
      if (typeof serialize !== 'function') return false;

      const classId = cls.classId;
      if (typeof classId !== 'string') {
        throw new Error(
          `Class "${cls.name}" with ${String(WORKFLOW_SERIALIZE)} must have a static "classId" property.`
        );
      }

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
