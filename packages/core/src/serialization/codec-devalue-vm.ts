/**
 * VM-compatible devalue codec.
 *
 * Same as codec-devalue.ts but uses VM-compatible reducers/revivers
 * (no Node.js Buffer, no node:util). Safe to bundle into the QuickJS VM.
 */

import { parse, stringify, unflatten } from 'devalue';
import type { Codec, SerializationMode } from './codec.js';
import {
  boundedDevalueParseOptions,
  boundedDevalueStringifyOptions,
} from './devalue-limits.js';
import { getClassReducers, getClassRevivers } from './reducers/class-vm.js';
import { getCommonReducers, getCommonRevivers } from './reducers/common-vm.js';
import {
  getStepFunctionReducer,
  getStepFunctionReviver,
} from './reducers/step-function-vm.js';
import { type Reducers, type Revivers, SerializationFormat } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- AbortController / AbortSignal (workflow VM context) ----
// Mirrors the node:vm engine's workflow-context abort reducers/revivers in
// serialization.ts: reduce by reading the stream/hook symbols stamped at
// controller construction; revive to the bootstrap's WorkflowAbortSignal
// class (looked up lazily on globalThis — the serde bundle is evaluated
// before the bootstrap defines it).
const ABORT_STREAM_NAME = Symbol.for('WORKFLOW_ABORT_STREAM_NAME');
const ABORT_HOOK_TOKEN = Symbol.for('WORKFLOW_ABORT_HOOK_TOKEN');

type AbortSerialized = {
  streamName: string;
  hookToken: string;
  aborted: boolean;
  reason?: unknown;
};

function reduceAbortBySymbol(
  signal: { aborted: boolean; reason?: unknown },
  holder: any
): AbortSerialized {
  const streamName =
    holder[ABORT_STREAM_NAME] ?? holder.signal?.[ABORT_STREAM_NAME];
  const hookToken =
    holder[ABORT_HOOK_TOKEN] ?? holder.signal?.[ABORT_HOOK_TOKEN];
  if (!streamName) {
    throw new Error('AbortController/AbortSignal stream name is not set');
  }
  return {
    streamName,
    hookToken,
    aborted: signal.aborted,
    reason: signal.aborted ? signal.reason : undefined,
  };
}

function reviveAbortSignalVM(value: AbortSerialized) {
  const Cls = (globalThis as any).__WorkflowAbortSignal;
  if (typeof Cls !== 'function') {
    throw new Error(
      'WorkflowAbortSignal is not registered in the VM (bootstrap not evaluated)'
    );
  }
  const signal = new Cls(value.streamName, value.hookToken);
  if (value.aborted) signal._setAborted(value.reason);
  return signal;
}

function getAbortReducersVM(): Partial<Reducers> {
  return {
    AbortController: (value) => {
      if (!value || typeof value !== 'object' || !value.signal) return false;
      const hasAbortSymbol =
        value[ABORT_STREAM_NAME] ?? value.signal?.[ABORT_STREAM_NAME];
      if (hasAbortSymbol === undefined) return false;
      return reduceAbortBySymbol(value.signal, value);
    },
    AbortSignal: (value) => {
      if (!value || typeof value !== 'object') return false;
      if ((value as any)[ABORT_STREAM_NAME] === undefined) return false;
      return reduceAbortBySymbol(value as any, value);
    },
  };
}

function getAbortReviversVM(): Partial<Revivers> {
  return {
    AbortController: (value: AbortSerialized) => ({
      [ABORT_STREAM_NAME]: value.streamName,
      [ABORT_HOOK_TOKEN]: value.hookToken,
      signal: reviveAbortSignalVM(value),
      abort: () => {},
    }),
    AbortSignal: (value: AbortSerialized) => reviveAbortSignalVM(value),
  };
}

function getReducersForMode(mode: SerializationMode): Partial<Reducers> {
  switch (mode) {
    case 'workflow':
      return {
        ...getAbortReducersVM(),
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
        ...getAbortReviversVM(),
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

/**
 * The workflow-mode reducer/reviver key sets — exported for the QuickJS
 * host serde's exhaustiveness test (quickjs-serde.test.ts), which pins
 * that the handle-space codec implements exactly these.
 */
export function getWorkflowModeReducerKeys(): string[] {
  return Object.keys(getReducersForMode('workflow'));
}
export function getWorkflowModeReviverKeys(): string[] {
  return Object.keys(getReviversForMode('workflow'));
}

export const devalueVmCodec: Codec = {
  formatPrefix: SerializationFormat.DEVALUE_V1,

  serialize(value: unknown, mode: SerializationMode): Uint8Array {
    const reducers = getReducersForMode(mode);
    const str = stringify(
      value,
      reducers as Record<string, (value: any) => any>,
      boundedDevalueStringifyOptions
    );
    return encoder.encode(str);
  },

  deserialize(data: Uint8Array, mode: SerializationMode): unknown {
    const revivers = getReviversForMode(mode);
    const str = decoder.decode(data);
    return parse(
      str,
      revivers as Record<string, (value: any) => any>,
      boundedDevalueParseOptions
    );
  },

  deserializeLegacy(data: unknown, mode: SerializationMode): unknown {
    const revivers = getReviversForMode(mode);
    return unflatten(
      data as any[],
      revivers as Record<string, (value: any) => any>,
      boundedDevalueParseOptions
    );
  },
};
