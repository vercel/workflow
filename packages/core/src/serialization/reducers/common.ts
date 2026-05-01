/**
 * Common reducers and revivers for types shared across all serialization modes.
 *
 * Handles: ArrayBuffer, BigInt, typed arrays, Date, Error, Headers, Map, Set,
 * RegExp, Request, Response, URL, URLSearchParams.
 *
 * Note: Uses Node.js Buffer for base64 encoding/decoding. For environments
 * without Buffer (e.g. QuickJS VM), a polyfill or alternative base64
 * implementation will be needed.
 */

import { types } from 'node:util';
import type { Reducers, Revivers, SerializableSpecial } from '../types.js';

// ---- Base64 helpers ----

function arrayBufferToBase64(
  value: ArrayBufferLike,
  offset: number,
  length: number
): string {
  // Avoid returning falsy value for zero-length buffers
  if (length === 0) return '.';
  // Create a proper copy to avoid ArrayBuffer detachment issues
  const uint8 = new Uint8Array(value, offset, length);
  return Buffer.from(uint8).toString('base64');
}

function viewToBase64(value: ArrayBufferView): string {
  return arrayBufferToBase64(value.buffer, value.byteOffset, value.byteLength);
}

function reviveArrayBuffer(
  value: string,
  global: Record<string, any>
): ArrayBuffer {
  const base64 = value === '.' ? '' : value;
  const buffer = Buffer.from(base64, 'base64');
  const arrayBuffer = new global.ArrayBuffer(buffer.length);
  const uint8Array = new global.Uint8Array(arrayBuffer);
  uint8Array.set(buffer);
  return arrayBuffer;
}

function revive(str: string) {
  // devalue.stringify() always produces valid JSON: special values
  // (undefined, NaN, Infinity, -0) are encoded as negative integer
  // sentinels and the remaining structure is ordinary JSON. Parsing
  // with JSON.parse yields the flattened form that unflatten() expects.
  return JSON.parse(str);
}

// ---- Reducers ----

export function getCommonReducers(
  global: Record<string, any> = globalThis
): Partial<Reducers> {
  return {
    ArrayBuffer: (value) =>
      value instanceof global.ArrayBuffer &&
      arrayBufferToBase64(value, 0, value.byteLength),
    BigInt: (value) => typeof value === 'bigint' && value.toString(),
    BigInt64Array: (value) =>
      value instanceof global.BigInt64Array && viewToBase64(value),
    BigUint64Array: (value) =>
      value instanceof global.BigUint64Array && viewToBase64(value),
    Date: (value) => {
      if (!(value instanceof global.Date)) return false;
      const valid = !Number.isNaN(value.getDate());
      return valid ? value.toISOString() : '.';
    },
    // DOMException is a special case: in Node.js it passes isNativeError()
    // and instanceof Error, but has a unique constructor signature
    // (message, name) and a read-only numeric `code` property derived from
    // `name`. It must be checked before the generic Error reducer.
    DOMException: (value) => {
      if (!types.isNativeError(value)) return false;
      if (value.constructor?.name !== 'DOMException') return false;
      const reduced: SerializableSpecial['DOMException'] = {
        message: value.message,
        name: value.name,
        stack: value.stack,
      };
      if ('cause' in value) reduced.cause = value.cause;
      return reduced;
    },
    Error: (value) => {
      // Use types.isNativeError() instead of `instanceof global.Error`
      // because errors may originate from a different VM context.
      if (!types.isNativeError(value)) return false;
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    },
    Float32Array: (value) =>
      value instanceof global.Float32Array && viewToBase64(value),
    Float64Array: (value) =>
      value instanceof global.Float64Array && viewToBase64(value),
    Headers: (value) => value instanceof global.Headers && Array.from(value),
    Int8Array: (value) =>
      value instanceof global.Int8Array && viewToBase64(value),
    Int16Array: (value) =>
      value instanceof global.Int16Array && viewToBase64(value),
    Int32Array: (value) =>
      value instanceof global.Int32Array && viewToBase64(value),
    Map: (value) => value instanceof global.Map && Array.from(value),
    RegExp: (value) =>
      value instanceof global.RegExp && {
        source: value.source,
        flags: value.flags,
      },
    // Request and Response are intentionally NOT in common reducers.
    // They require mode-specific revivers (stream handling, etc.) and
    // including them here without matching revivers would cause them
    // to deserialize as plain objects.
    Set: (value) => value instanceof global.Set && Array.from(value),
    URL: (value) => value instanceof global.URL && value.href,
    WorkflowFunction: (value) => {
      // Only match function references with a workflowId property (set by
      // the SWC compiler on workflow functions). Plain { workflowId } objects
      // are NOT matched — this prevents infinite recursion since the reduced
      // form { workflowId } is a plain object, not a function.
      if (typeof value !== 'function') return false;
      const workflowId = (value as any).workflowId;
      if (typeof workflowId !== 'string') return false;
      return { workflowId };
    },
    URLSearchParams: (value) => {
      if (!(value instanceof global.URLSearchParams)) return false;
      if (value.size === 0) return '.';
      return String(value);
    },
    Uint8Array: (value) =>
      value instanceof global.Uint8Array && viewToBase64(value),
    Uint8ClampedArray: (value) =>
      value instanceof global.Uint8ClampedArray && viewToBase64(value),
    Uint16Array: (value) =>
      value instanceof global.Uint16Array && viewToBase64(value),
    Uint32Array: (value) =>
      value instanceof global.Uint32Array && viewToBase64(value),
  };
}

// ---- Revivers ----

export function getCommonRevivers(
  global: Record<string, any> = globalThis
): Partial<Revivers> {
  return {
    ArrayBuffer: (value: string) => reviveArrayBuffer(value, global),
    BigInt: (value: string) => global.BigInt(value),
    BigInt64Array: (value: string) =>
      new global.BigInt64Array(reviveArrayBuffer(value, global)),
    BigUint64Array: (value: string) =>
      new global.BigUint64Array(reviveArrayBuffer(value, global)),
    Date: (value) => new global.Date(value),
    DOMException: (value) => {
      const error = new global.DOMException(value.message, value.name);
      if (value.stack !== undefined) error.stack = value.stack;
      // DOMException's constructor doesn't accept a cause option, so
      // we set it manually when present in the serialized data.
      if ('cause' in value) error.cause = value.cause;
      return error;
    },
    Error: (value) => {
      const error = new global.Error(value.message);
      error.name = value.name;
      error.stack = value.stack;
      return error;
    },
    Float32Array: (value: string) =>
      new global.Float32Array(reviveArrayBuffer(value, global)),
    Float64Array: (value: string) =>
      new global.Float64Array(reviveArrayBuffer(value, global)),
    Headers: (value) => new global.Headers(value),
    Int8Array: (value: string) =>
      new global.Int8Array(reviveArrayBuffer(value, global)),
    Int16Array: (value: string) =>
      new global.Int16Array(reviveArrayBuffer(value, global)),
    Int32Array: (value: string) =>
      new global.Int32Array(reviveArrayBuffer(value, global)),
    Map: (value) => new global.Map(value),
    RegExp: (value) => new global.RegExp(value.source, value.flags),
    Set: (value) => new global.Set(value),
    URL: (value) => new global.URL(value),
    WorkflowFunction: (value) =>
      Object.assign(
        () => {
          throw new Error(
            'Workflow functions cannot be called directly. Use start() to invoke them.'
          );
        },
        { workflowId: value.workflowId }
      ),
    URLSearchParams: (value) =>
      new global.URLSearchParams(value === '.' ? '' : value),
    Uint8Array: (value: string) =>
      new global.Uint8Array(reviveArrayBuffer(value, global)),
    Uint8ClampedArray: (value: string) =>
      new global.Uint8ClampedArray(reviveArrayBuffer(value, global)),
    Uint16Array: (value: string) =>
      new global.Uint16Array(reviveArrayBuffer(value, global)),
    Uint32Array: (value: string) =>
      new global.Uint32Array(reviveArrayBuffer(value, global)),
  };
}

// Re-export for use in legacy compat
export { revive };
