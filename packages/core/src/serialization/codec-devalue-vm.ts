/**
 * VM-compatible devalue codec.
 *
 * Same as codec-devalue.ts but uses VM-compatible reducers/revivers
 * (no Node.js Buffer, no node:util). Safe to bundle into the QuickJS VM.
 */

import { parse, stringify, unflatten } from 'devalue';
import { SerializationFormat, type Reducers, type Revivers } from './types.js';
import type { Codec, SerializationMode } from './codec.js';
import { getClassReducers, getClassRevivers } from './reducers/class.js';
import { getCommonReducers, getCommonRevivers } from './reducers/common-vm.js';
import {
  getStepFunctionReducer,
  getStepFunctionReviver,
} from './reducers/step-function.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function getReducersForMode(mode: SerializationMode): Partial<Reducers> {
  switch (mode) {
    case 'workflow':
      return {
        ...getClassReducers(),
        ...getStepFunctionReducer(),
        ...getCommonReducers(),
      };
    case 'step':
      return {
        ...getClassReducers(),
        ...getCommonReducers(),
      };
    case 'client':
      return {
        ...getClassReducers(),
        ...getCommonReducers(),
      };
  }
}

function getReviversForMode(mode: SerializationMode): Partial<Revivers> {
  switch (mode) {
    case 'workflow':
      return {
        ...getClassRevivers(),
        ...getStepFunctionReviver(),
        ...getCommonRevivers(),
      };
    case 'step':
      return {
        ...getClassRevivers(),
        ...getCommonRevivers(),
      };
    case 'client':
      return {
        ...getClassRevivers(),
        ...getCommonRevivers(),
        StepFunction: () => {
          throw new Error(
            'Step functions cannot be deserialized in client context.'
          );
        },
      };
  }
}

export const devalueVmCodec: Codec = {
  formatPrefix: SerializationFormat.DEVALUE_V1,

  serialize(value: unknown, mode: SerializationMode): Uint8Array {
    const reducers = getReducersForMode(mode);
    const str = stringify(
      value,
      reducers as Record<string, (value: any) => any>
    );
    return encoder.encode(str);
  },

  deserialize(data: Uint8Array, mode: SerializationMode): unknown {
    const revivers = getReviversForMode(mode);
    const str = decoder.decode(data);
    return parse(str, revivers as Record<string, (value: any) => any>);
  },

  deserializeLegacy(data: unknown, mode: SerializationMode): unknown {
    const revivers = getReviversForMode(mode);
    return unflatten(
      data as any[],
      revivers as Record<string, (value: any) => any>
    );
  },
};
