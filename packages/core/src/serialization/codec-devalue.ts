/**
 * Devalue codec implementation.
 *
 * Uses the `devalue` library for serialization. Handles custom types via
 * reducers (serialize) and revivers (deserialize) which are composed
 * internally based on the serialization mode.
 *
 * The reducer/reviver pattern is specific to devalue — other codecs
 * (CBOR, JSON) would handle types differently (e.g. CBOR supports Date,
 * typed arrays, Map, Set natively).
 */

import { parse, stringify, unflatten } from 'devalue';
import type { Codec, CodecOptions, SerializationMode } from './codec.js';
import { getClassReducers, getClassRevivers } from './reducers/class.js';
import { getCommonReducers, getCommonRevivers } from './reducers/common.js';
import {
  getStepFunctionReducer,
  getStepFunctionReviver,
} from './reducers/step-function.js';
import { type Reducers, type Revivers, SerializationFormat } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- Reducer/Reviver composition per mode ----

function getReducersForMode(
  mode: SerializationMode,
  global: Record<string, any> = globalThis,
  extraReducers?: Record<string, (value: any) => any>
): Record<string, (value: any) => any> {
  let base: Partial<Reducers>;
  switch (mode) {
    case 'workflow':
      // Class/Instance MUST come before common (first-match-wins for Error subclasses)
      base = {
        ...getClassReducers(),
        ...getStepFunctionReducer(),
        ...getCommonReducers(global),
      };
      break;
    case 'step':
      base = {
        ...getClassReducers(),
        ...getCommonReducers(global),
      };
      break;
    case 'client':
      base = {
        ...getClassReducers(),
        ...getCommonReducers(global),
      };
      break;
  }
  if (extraReducers) {
    return { ...base, ...extraReducers } as Record<string, (value: any) => any>;
  }
  return base as Record<string, (value: any) => any>;
}

function getReviversForMode(
  mode: SerializationMode,
  global: Record<string, any> = globalThis,
  extraRevivers?: Record<string, (value: any) => any>
): Record<string, (value: any) => any> {
  let base: Partial<Revivers>;
  switch (mode) {
    case 'workflow':
      base = {
        ...getClassRevivers(global),
        ...getStepFunctionReviver(global),
        ...getCommonRevivers(global),
      };
      break;
    case 'step':
      base = {
        ...getClassRevivers(global),
        ...getCommonRevivers(global),
      };
      break;
    case 'client':
      base = {
        ...getClassRevivers(global),
        ...getCommonRevivers(global),
        StepFunction: () => {
          throw new Error(
            'Step functions cannot be deserialized in client context.'
          );
        },
      };
      break;
  }
  if (extraRevivers) {
    return { ...base, ...extraRevivers } as Record<string, (value: any) => any>;
  }
  return base as Record<string, (value: any) => any>;
}

// ---- Codec implementation ----

export const devalueCodec: Codec = {
  formatPrefix: SerializationFormat.DEVALUE_V1,

  serialize(
    value: unknown,
    mode: SerializationMode,
    options?: CodecOptions
  ): Uint8Array {
    const reducers = getReducersForMode(
      mode,
      options?.global,
      options?.extraReducers
    );
    const str = stringify(value, reducers);
    return encoder.encode(str);
  },

  deserialize(
    data: Uint8Array,
    mode: SerializationMode,
    options?: CodecOptions
  ): unknown {
    const revivers = getReviversForMode(
      mode,
      options?.global,
      options?.extraRevivers
    );
    const str = decoder.decode(data);
    return parse(str, revivers);
  },

  deserializeLegacy(
    data: unknown,
    mode: SerializationMode,
    options?: CodecOptions
  ): unknown {
    const revivers = getReviversForMode(
      mode,
      options?.global,
      options?.extraRevivers
    );
    return unflatten(data as any[], revivers);
  },
};
