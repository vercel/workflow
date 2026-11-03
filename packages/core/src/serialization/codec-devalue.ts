/**
 * Devalue codec implementation.
 *
 * Uses the `devalue` library for serialization. Handles custom types via
 * reducers (serialize) and revivers (deserialize) which are composed
 * internally based on the serialization mode.
 *
 * The reducer/reviver pattern is specific to devalue: other codecs
 * (CBOR, JSON) would handle types differently (e.g. CBOR supports Date,
 * typed arrays, Map, Set natively).
 */

import {
  defaultParseOperations,
  type ParseOptions,
  parse,
  stringify,
  unflatten,
} from 'devalue';
import type { Codec, CodecOptions, SerializationMode } from './codec.js';
import { hardenedStringifyOperations, withGuestCodeStats } from './hardened.js';
import { getClassReducers, getClassRevivers } from './reducers/class.js';
import { getCommonReducers, getCommonRevivers } from './reducers/common.js';
import {
  getStepFunctionReducer,
  getStepFunctionReviver,
} from './reducers/step-function.js';
import {
  STATE_REF_REDUCER,
  STATE_SOURCE_REDUCER,
  StateContext,
  stateContextForGlobal,
} from './state-refs.js';
import { type Reducers, type Revivers, SerializationFormat } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_SPARSE_ARRAY_LENGTH = 100_000;

const parseOptions = {
  operations: {
    createSparseArray(length) {
      if (length > MAX_SPARSE_ARRAY_LENGTH) {
        throw new RangeError(
          `Sparse array length ${length} exceeds the maximum of ${MAX_SPARSE_ARRAY_LENGTH}`
        );
      }
      return defaultParseOperations.createSparseArray(length);
    },
  },
} satisfies ParseOptions;

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

/**
 * The replay's state context for this payload. Without one, the payload is
 * read outside a run's log (a hook payload, for example), so it is written
 * without state records.
 */
function stateContextFor(options?: CodecOptions): StateContext {
  return (
    options?.stateContext ??
    stateContextForGlobal(options?.global ?? globalThis) ??
    StateContext.standalone()
  );
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
    // Hardened operations: devalue's own introspection (classification,
    // built-in extraction, property reads) goes through captured host
    // intrinsics and descriptor reads, so serializing a value constructed
    // inside a workflow VM cannot execute sandbox code behind our back.
    // Where workflow code must run (getters, proxies, custom serializers),
    // the execution is recorded into `options.guestCodeStats`.
    const state = stateContextFor(options);
    state.beginWrite();
    reducers[STATE_REF_REDUCER] = options?.stateInput
      ? state.reduceInput
      : state.reduce;
    reducers[STATE_SOURCE_REDUCER] = state.reduceSourceRef;
    const str = withGuestCodeStats(options?.guestCodeStats, () =>
      stringify(value, reducers, { operations: hardenedStringifyOperations })
    );
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
    // Caller-supplied state revivers (an inspection resolver) take precedence.
    if (!options?.extraRevivers?.[STATE_REF_REDUCER]) {
      const state = stateContextFor(options);
      revivers[STATE_REF_REDUCER] = options?.stateInput
        ? state.reviveInput
        : state.revive;
      revivers[STATE_SOURCE_REDUCER] = state.reviveSourceRef;
    }
    const str = decoder.decode(data);
    return parse(str, revivers, parseOptions);
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
    return unflatten(data as any[], revivers, parseOptions);
  },
};
