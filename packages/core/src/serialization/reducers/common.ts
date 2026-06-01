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
import {
  FatalError,
  HookConflictError,
  RetryableError,
  RuntimeDecryptionError,
} from '@workflow/errors';
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

// ---- Error subclass helpers ----

/**
 * The shared shape that every Error-subclass reducer in this module
 * produces. Some subclasses (e.g. `AggregateError`, `RetryableError`) extend
 * this with additional fields by spreading the base payload.
 */
type BaseErrorPayload = {
  message: string;
  stack?: string;
  cause?: unknown;
};

/**
 * Subset of `SerializableSpecial` keys whose payload shape is exactly the
 * `BaseErrorPayload`. `makeErrorSubclassReducer` is constrained to only
 * these keys so its return type is sound — subclasses that need extra
 * fields (like `AggregateError.errors` or `RetryableError.retryAfter`) use
 * `reduceErrorBase` directly and extend the result.
 */
type SimpleErrorSubclassKey = {
  [K in keyof SerializableSpecial]: SerializableSpecial[K] extends BaseErrorPayload
    ? BaseErrorPayload extends SerializableSpecial[K]
      ? K
      : never
    : never;
}[keyof SerializableSpecial];

/**
 * Reduces any native Error instance to the shared `BaseErrorPayload` shape,
 * preserving `cause` only when present (to distinguish "no cause" from
 * "cause is undefined"). Used directly by reducers for subclasses that need
 * to extend the shape with additional fields.
 *
 * `types.isNativeError()` is used instead of `instanceof` for cross-VM safety:
 * errors may originate from a different VM context, and `instanceof` fails
 * across VM boundaries since each context has its own Error constructor.
 */
function reduceErrorBase(value: unknown): BaseErrorPayload | false {
  if (!types.isNativeError(value)) return false;
  const reduced: BaseErrorPayload = {
    message: value.message,
    stack: value.stack,
  };
  if ('cause' in value) reduced.cause = (value as { cause: unknown }).cause;
  return reduced;
}

/**
 * Reduces a native error to the shared `BaseErrorPayload`, but only when its
 * `name` instance property matches `subclassName`. Used by:
 *   - `makeErrorSubclassReducer`, for subclasses whose serialized shape is
 *     exactly `BaseErrorPayload`.
 *   - Inline reducers for subclasses that extend the shape with additional
 *     fields (e.g. `AggregateError.errors`, `RetryableError.retryAfter`).
 *
 * Matching by `value.name` (instead of `value.constructor?.name`) is robust
 * to bundlers that emit the class as an anonymous expression — e.g. Turbopack
 * compiles `export class FatalError extends Error {…}` to a registration call
 * like `e.s(["FatalError", 0, class extends Error {…}])`, and the resulting
 * constructor has `name === ''`. Since every Error subclass we care about
 * sets `this.name` explicitly in its constructor (built-in subclasses do this
 * automatically; `FatalError`/`RetryableError` do it in user code), the
 * instance property is the reliable identity marker across realms and
 * bundlers.
 */
function reduceNamedErrorSubclassBase(
  subclassName: string,
  value: unknown
): BaseErrorPayload | false {
  if (!types.isNativeError(value)) return false;
  if (value.name !== subclassName) return false;
  return reduceErrorBase(value);
}

/**
 * Creates a reducer for a built-in Error subclass whose serialized shape is
 * exactly `BaseErrorPayload` (no extra fields). The reducer matches by
 * constructor name (after the isNativeError gate), since `instanceof` may
 * fail across VM boundaries.
 */
function makeErrorSubclassReducer<K extends SimpleErrorSubclassKey>(
  subclassName: K
) {
  return (value: unknown): SerializableSpecial[K] | false => {
    const base = reduceNamedErrorSubclassBase(subclassName, value);
    if (!base) return false;
    return base as SerializableSpecial[K];
  };
}

/**
 * Creates a reviver for a built-in Error subclass. Reconstructs the correct
 * built-in Error type using the context's constructor. The `cause` option is
 * only passed when the serialized data includes it, preserving the distinction
 * between "no cause" and "cause is undefined".
 */
function makeErrorSubclassReviver<K extends keyof SerializableSpecial>(
  global: Record<string, any>,
  ctorName: string
) {
  return (value: SerializableSpecial[K]) => {
    const v = value as BaseErrorPayload;
    const opts = 'cause' in v ? { cause: v.cause } : undefined;
    const Ctor = global[ctorName];
    const error: Error = new Ctor(v.message, opts);
    if (v.stack !== undefined) error.stack = v.stack;
    return error;
  };
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
    // DOMException is a special case: it `instanceof Error` is true in Node,
    // but `types.isNativeError()` returns FALSE for it, so the generic Error
    // reducer (which gates on isNativeError) won't match. Check it explicitly
    // by constructor name + Error inheritance so we catch DOMExceptions from
    // any realm (cross-VM safety: instanceof global.DOMException would fail
    // for instances minted in another context).
    DOMException: (value) => {
      if (value === null || typeof value !== 'object') return false;
      if (
        (value as { constructor?: { name?: string } }).constructor?.name !==
        'DOMException'
      )
        return false;
      const e = value as Error & { cause?: unknown };
      const reduced: SerializableSpecial['DOMException'] = {
        message: e.message,
        name: e.name,
        stack: e.stack,
      };
      if ('cause' in e) reduced.cause = e.cause;
      return reduced;
    },
    // Error subclass reducers are intentionally placed before the base Error
    // reducer because devalue uses first-match-wins. Subclass-specific reducers
    // must be checked first so that e.g. a TypeError is serialized as "TypeError"
    // rather than falling through to the generic "Error" reducer.
    // See `makeErrorSubclassReducer` for implementation details.
    EvalError: makeErrorSubclassReducer('EvalError'),
    FatalError: makeErrorSubclassReducer('FatalError'),
    HookConflictError: (value) => {
      const base = reduceNamedErrorSubclassBase('HookConflictError', value);
      if (!base) return false;
      const error = value as HookConflictError;
      const reduced: SerializableSpecial['HookConflictError'] = {
        ...base,
        token: error.token,
      };
      if (error.conflictingRunId !== undefined) {
        reduced.conflictingRunId = error.conflictingRunId;
      }
      return reduced;
    },
    RangeError: makeErrorSubclassReducer('RangeError'),
    ReferenceError: makeErrorSubclassReducer('ReferenceError'),
    // RetryableError carries an extra `retryAfter` Date that we serialize as
    // a numeric epoch timestamp. The Date reducer uses `instanceof global.Date`,
    // which fails for Dates from a different VM realm; serializing as a
    // number sidesteps that issue.
    RetryableError: (value) => {
      const base = reduceNamedErrorSubclassBase('RetryableError', value);
      if (!base) return false;
      const retryAfterRaw = (value as RetryableError).retryAfter as unknown;
      let retryAfter: number;
      if (
        retryAfterRaw &&
        typeof retryAfterRaw === 'object' &&
        typeof (retryAfterRaw as { getTime?: unknown }).getTime === 'function'
      ) {
        const t = (retryAfterRaw as Date).getTime();
        retryAfter = Number.isNaN(t) ? Date.now() + 1000 : t;
      } else if (
        typeof retryAfterRaw === 'string' ||
        typeof retryAfterRaw === 'number'
      ) {
        const t = new Date(retryAfterRaw).getTime();
        retryAfter = Number.isNaN(t) ? Date.now() + 1000 : t;
      } else {
        retryAfter = Date.now() + 1000;
      }
      return {
        ...base,
        retryAfter,
      } satisfies SerializableSpecial['RetryableError'];
    },
    // RuntimeDecryptionError carries an extra `context` object (operation,
    // byteLength, formatPrefix) that the generic Error reducer would drop.
    // Preserve it so the diagnostic data survives the run-error round trip.
    RuntimeDecryptionError: (value) => {
      const base = reduceNamedErrorSubclassBase(
        'RuntimeDecryptionError',
        value
      );
      if (!base) return false;
      const reduced: SerializableSpecial['RuntimeDecryptionError'] = {
        ...base,
      };
      const context = (value as RuntimeDecryptionError).context;
      if (context !== undefined) {
        reduced.context = context;
      }
      return reduced;
    },
    SyntaxError: makeErrorSubclassReducer('SyntaxError'),
    TypeError: makeErrorSubclassReducer('TypeError'),
    URIError: makeErrorSubclassReducer('URIError'),
    // AggregateError is similar to other subclasses but also preserves the
    // `errors` array. We extend the base helper's output here.
    AggregateError: (value) => {
      const base = reduceNamedErrorSubclassBase('AggregateError', value);
      if (!base) return false;
      return {
        ...base,
        errors: (value as AggregateError).errors,
      } satisfies SerializableSpecial['AggregateError'];
    },
    // Base Error reducer — catch-all for any Error instance not matched by a
    // specific subclass reducer above (including user Error subclasses without
    // WORKFLOW_SERIALIZE). Preserves `name` so the error's identity is retained
    // even though the exact class cannot be reconstructed.
    Error: (value) => {
      if (!types.isNativeError(value)) return false;
      const reduced: SerializableSpecial['Error'] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      if ('cause' in value) reduced.cause = value.cause;
      return reduced;
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
    // Error subclass revivers reconstruct the correct built-in Error type.
    // See `makeErrorSubclassReviver` for implementation details.
    EvalError: makeErrorSubclassReviver(global, 'EvalError'),
    // `FatalError` and `RetryableError` are not built-ins, so we resolve them
    // from the consumer's `globalThis` via a `Symbol.for(...)` key registered
    // by `@workflow/errors` on load. This makes `instanceof FatalError` work
    // in user code that lives in a different realm than this reducer module
    // (e.g. when the host hydrates a value destined for a workflow VM
    // context). See the registration block at the bottom of
    // `packages/errors/src/index.ts` for details. Falls back to the imported
    // class for environments where no bundled `@workflow/errors` has loaded
    // in the consumer realm.
    FatalError: (value) => {
      const Ctor =
        ((global as Record<symbol, unknown>)[
          Symbol.for('@workflow/errors//FatalError')
        ] as typeof FatalError | undefined) ?? FatalError;
      const error = new Ctor(value.message);
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) error.cause = value.cause;
      return error;
    },
    HookConflictError: (value) => {
      const Ctor =
        ((global as Record<symbol, unknown>)[
          Symbol.for('@workflow/errors//HookConflictError')
        ] as typeof HookConflictError | undefined) ?? HookConflictError;
      const error = new Ctor(value.token, value.conflictingRunId);
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) {
        (error as Error & { cause?: unknown }).cause = value.cause;
      }
      return error;
    },
    RangeError: makeErrorSubclassReviver(global, 'RangeError'),
    ReferenceError: makeErrorSubclassReviver(global, 'ReferenceError'),
    RetryableError: (value) => {
      // Use the context's `Date` constructor (matching the rest of this
      // module) so the resulting `retryAfter` Date passes `instanceof
      // global.Date` checks in the target realm. See the FatalError reviver
      // above for why we resolve `RetryableError` from the consumer's
      // globalThis instead of the imported class.
      const Ctor =
        ((global as Record<symbol, unknown>)[
          Symbol.for('@workflow/errors//RetryableError')
        ] as typeof RetryableError | undefined) ?? RetryableError;
      const error = new Ctor(value.message, {
        retryAfter: new global.Date(value.retryAfter),
      });
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) error.cause = value.cause;
      return error;
    },
    RuntimeDecryptionError: (value) => {
      // Resolve from the consumer's globalThis (see the FatalError reviver
      // above) so `instanceof RuntimeDecryptionError` holds across realms.
      const Ctor =
        ((global as Record<symbol, unknown>)[
          Symbol.for('@workflow/errors//RuntimeDecryptionError')
        ] as typeof RuntimeDecryptionError | undefined) ??
        RuntimeDecryptionError;
      const opts: ConstructorParameters<typeof RuntimeDecryptionError>[1] = {};
      if ('cause' in value) opts.cause = value.cause;
      if (value.context !== undefined) opts.context = value.context;
      const error = new Ctor(value.message, opts);
      if (value.stack !== undefined) error.stack = value.stack;
      return error;
    },
    SyntaxError: makeErrorSubclassReviver(global, 'SyntaxError'),
    TypeError: makeErrorSubclassReviver(global, 'TypeError'),
    URIError: makeErrorSubclassReviver(global, 'URIError'),
    AggregateError: (value) => {
      const opts = 'cause' in value ? { cause: value.cause } : undefined;
      const error = new global.AggregateError(
        value.errors,
        value.message,
        opts
      );
      if (value.stack !== undefined) error.stack = value.stack;
      return error;
    },
    // Base Error reviver — used for plain Error instances and unrecognized
    // Error subclasses. Preserves `name` so the error's identity is retained.
    Error: (value) => {
      const opts = 'cause' in value ? { cause: value.cause } : undefined;
      const error = new global.Error(value.message, opts);
      error.name = value.name;
      if (value.stack !== undefined) error.stack = value.stack;
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
