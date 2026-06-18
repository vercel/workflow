/**
 * VM-compatible common reducers and revivers.
 *
 * Identical to common.ts but without Node.js dependencies:
 * - Uses native `btoa` / `atob` (provided by quickjs-wasi's base64
 *   extension, see `quickjs-assets.generated.ts`) instead of Buffer
 *   or pure-JS base64.
 * - Uses `instanceof Error` instead of `types.isNativeError()`.
 *
 * This module is safe to bundle into the QuickJS WASM VM.
 */

import type { Reducers, Revivers, SerializableSpecial } from '../types.js';

// ---- Base64 helpers (native btoa/atob from the quickjs-wasi base64 extension) ----

function arrayBufferToBase64(
  value: ArrayBufferLike,
  offset: number,
  length: number
): string {
  if (length === 0) return '.';
  // btoa requires a binary string. Build it from the byte view.
  const uint8 = new Uint8Array(value, offset, length);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]!);
  }
  return btoa(binary);
}

function viewToBase64(value: ArrayBufferView): string {
  return arrayBufferToBase64(value.buffer, value.byteOffset, value.byteLength);
}

function reviveArrayBuffer(value: string): ArrayBuffer {
  if (value === '.') return new ArrayBuffer(0);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

// ---- Error subclass helper ----

// Creates a reducer for a built-in Error subclass whose serialized shape
// is exactly { message, stack, cause? }. Matches by `value.name`
// (instance property) for cross-realm + bundler-output robustness — see
// the host-side common.ts for full rationale.
function makeNamedErrorSubclassReducer(subclassName: string) {
  return (
    value: unknown
  ): { message: string; stack?: string; cause?: unknown } | false => {
    if (!(value instanceof Error)) return false;
    if (value.name !== subclassName) return false;
    const reduced: { message: string; stack?: string; cause?: unknown } = {
      message: value.message,
      stack: value.stack,
    };
    if ('cause' in value) reduced.cause = (value as { cause: unknown }).cause;
    return reduced;
  };
}

// Creates a reviver for a built-in Error subclass. Looks up the
// constructor on globalThis so the resulting object passes
// `instanceof TypeError` etc. in the consuming realm. Falls back to
// a base Error with the right `.name` if the constructor is not
// available (defensive — built-ins always exist).
function makeNamedErrorSubclassReviver(subclassName: string) {
  return (value: { message: string; stack?: string; cause?: unknown }) => {
    const Cls = (globalThis as any)[subclassName];
    let error: Error;
    if (typeof Cls === 'function') {
      error = new Cls(value.message);
    } else {
      error = new Error(value.message);
      error.name = subclassName;
    }
    if (value.stack !== undefined) error.stack = value.stack;
    if ('cause' in value) (error as any).cause = (value as any).cause;
    return error;
  };
}

// ---- Reducers ----

export function getCommonReducers(): Partial<Reducers> {
  return {
    ArrayBuffer: (value) =>
      value instanceof ArrayBuffer &&
      arrayBufferToBase64(value, 0, value.byteLength),
    BigInt: (value) => typeof value === 'bigint' && value.toString(),
    BigInt64Array: (value) =>
      value instanceof BigInt64Array && viewToBase64(value),
    BigUint64Array: (value) =>
      value instanceof BigUint64Array && viewToBase64(value),
    Date: (value) => {
      if (!(value instanceof Date)) return false;
      const valid = !Number.isNaN(value.getDate());
      return valid ? value.toISOString() : '.';
    },
    // DOMException is checked before Error so that DOMException-specific
    // shape (name, message, stack, cause) survives the round-trip.
    DOMException: (value) => {
      if (!(value instanceof DOMException)) return false;
      const reduced: SerializableSpecial['DOMException'] = {
        message: value.message,
        name: value.name,
        stack: value.stack,
      };
      if ('cause' in value) reduced.cause = (value as any).cause;
      return reduced;
    },
    // First-class Error subclass reducers. Order matters: each subclass
    // reducer is checked before the generic `Error` catch-all so that
    // e.g. a TypeError instance routes through the TypeError reducer
    // instead of the base Error reducer. Matching is by `value.name`
    // (the instance property) for cross-realm + bundler robustness;
    // see common.ts for full rationale.
    AggregateError: (value) => {
      if (!(value instanceof Error) || value.name !== 'AggregateError')
        return false;
      const reduced: SerializableSpecial['AggregateError'] = {
        message: value.message,
        stack: value.stack,
        errors: (value as AggregateError).errors,
      };
      if ('cause' in value) reduced.cause = (value as any).cause;
      return reduced;
    },
    EvalError: makeNamedErrorSubclassReducer('EvalError'),
    FatalError: makeNamedErrorSubclassReducer('FatalError'),
    RangeError: makeNamedErrorSubclassReducer('RangeError'),
    ReferenceError: makeNamedErrorSubclassReducer('ReferenceError'),
    // RetryableError carries an extra retryAfter; serialize as numeric
    // epoch timestamp for cross-realm safety (see host-side common.ts).
    RetryableError: (value) => {
      if (!(value instanceof Error) || value.name !== 'RetryableError')
        return false;
      const retryAfterRaw = (value as any).retryAfter;
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
      const reduced: SerializableSpecial['RetryableError'] = {
        message: value.message,
        stack: value.stack,
        retryAfter,
      };
      if ('cause' in value) reduced.cause = (value as any).cause;
      return reduced;
    },
    SyntaxError: makeNamedErrorSubclassReducer('SyntaxError'),
    TypeError: makeNamedErrorSubclassReducer('TypeError'),
    URIError: makeNamedErrorSubclassReducer('URIError'),
    // Base Error reducer — catch-all. Matched LAST after subclass-specific
    // reducers above. Preserves `name` so user Error subclasses without
    // dedicated reducers retain their identity through the round-trip.
    Error: (value) => {
      // In the VM, use instanceof Error (no node:util available)
      if (!(value instanceof Error)) return false;
      const reduced: SerializableSpecial['Error'] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      if ('cause' in value) reduced.cause = (value as any).cause;
      return reduced;
    },
    Float32Array: (value) =>
      value instanceof Float32Array && viewToBase64(value),
    Float64Array: (value) =>
      value instanceof Float64Array && viewToBase64(value),
    Int8Array: (value) => value instanceof Int8Array && viewToBase64(value),
    Int16Array: (value) => value instanceof Int16Array && viewToBase64(value),
    Int32Array: (value) => value instanceof Int32Array && viewToBase64(value),
    Map: (value) => value instanceof Map && Array.from(value),
    RegExp: (value) =>
      value instanceof RegExp && {
        source: value.source,
        flags: value.flags,
      },
    // Request/Response/Headers — serialize using the polyfill constructors
    Headers: (value) => {
      const H = (globalThis as any).Headers;
      if (!H || !(value instanceof H)) return false;
      return Array.from(value as Iterable<[string, string]>);
    },
    Request: (value) => {
      const R = (globalThis as any).Request;
      if (!R) return false;
      // Use instanceof OR check for the Request-specific .json method
      // (duck-typing on method/url alone would match plain objects and
      // cause infinite recursion since the reducer output also has those)
      if (!(value instanceof R) && typeof value?.json !== 'function')
        return false;
      if (typeof value?.method !== 'string') return false;
      const data: any = {
        method: value.method,
        url: value.url,
        headers: value.headers,
        body: value.body,
        duplex: value.duplex,
      };
      // Include the webhook response writable stream if present
      const responseWritable = value[Symbol.for('WEBHOOK_RESPONSE_WRITABLE')];
      if (responseWritable) {
        data.responseWritable = responseWritable;
      }
      return data;
    },
    Response: (value) => {
      const R = (globalThis as any).Response;
      if (!R) return false;
      // Use instanceof OR check for Response-specific .clone method
      if (!(value instanceof R) && typeof value?.clone !== 'function')
        return false;
      if (typeof value?.status !== 'number') return false;
      return {
        type: value.type,
        url: value.url,
        status: value.status,
        statusText: value.statusText,
        headers: value.headers,
        body: value.body,
        redirected: value.redirected,
      };
    },
    ReadableStream: ((value: any) => {
      if (value == null) return false;
      const RS = (globalThis as any).ReadableStream;
      if (
        !RS ||
        !(value instanceof RS || Object.getPrototypeOf(value) === RS.prototype)
      )
        return false;
      const bodyInit = value[Symbol.for('BODY_INIT')];
      if (bodyInit !== undefined) {
        return { bodyInit };
      }
      // Preserve stream name if present (opaque pointer for passing to steps)
      const name = value[Symbol.for('WORKFLOW_STREAM_NAME')];
      if (name) {
        const s: any = { name };
        const type = value[Symbol.for('WORKFLOW_STREAM_TYPE')];
        if (type) s.type = type;
        return s;
      }
      return { name: '__empty' };
    }) as any,
    WritableStream: ((value: any) => {
      if (value == null) return false;
      const WS = (globalThis as any).WritableStream;
      if (
        !WS ||
        !(value instanceof WS || Object.getPrototypeOf(value) === WS.prototype)
      )
        return false;
      const name = value[Symbol.for('WORKFLOW_STREAM_NAME')];
      return { name: name || '__empty' };
    }) as any,
    Set: (value) => value instanceof Set && Array.from(value),
    URL: (value) => value instanceof URL && value.href,
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
      if (!(value instanceof URLSearchParams)) return false;
      return value.size === 0 ? '.' : String(value);
    },
    Uint8Array: (value) => value instanceof Uint8Array && viewToBase64(value),
    Uint8ClampedArray: (value) =>
      value instanceof Uint8ClampedArray && viewToBase64(value),
    Uint16Array: (value) => value instanceof Uint16Array && viewToBase64(value),
    Uint32Array: (value) => value instanceof Uint32Array && viewToBase64(value),
  };
}

// ---- Revivers ----

export function getCommonRevivers(): Partial<Revivers> {
  return {
    ArrayBuffer: (value: string) => reviveArrayBuffer(value),
    BigInt: (value: string) => BigInt(value),
    BigInt64Array: (value: string) =>
      new BigInt64Array(reviveArrayBuffer(value)),
    BigUint64Array: (value: string) =>
      new BigUint64Array(reviveArrayBuffer(value)),
    Date: (value) => new Date(value),
    DOMException: (value) => {
      const error = new DOMException(value.message, value.name);
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) (error as any).cause = value.cause;
      return error;
    },
    AggregateError: (value) => {
      const error = new AggregateError(value.errors ?? [], value.message);
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) (error as any).cause = value.cause;
      return error;
    },
    EvalError: makeNamedErrorSubclassReviver('EvalError'),
    FatalError: (value) => {
      // Prefer the host-registered FatalError class (registered via
      // Symbol.for keys by @workflow/errors so `instanceof FatalError`
      // works across realms). Fall back to a synthesized Error with
      // the right .name when no registration is present.
      // FatalError's constructor takes only `message`, so cause is
      // attached as a property after construction (matching the host
      // reviver in common.ts).
      const Cls = (globalThis as any)[
        Symbol.for('@workflow/errors//FatalError')
      ];
      let error: Error;
      if (typeof Cls === 'function') {
        error = new Cls(value.message);
      } else {
        error = new Error(value.message);
        error.name = 'FatalError';
      }
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) (error as any).cause = (value as any).cause;
      return error;
    },
    RangeError: makeNamedErrorSubclassReviver('RangeError'),
    ReferenceError: makeNamedErrorSubclassReviver('ReferenceError'),
    RetryableError: (value) => {
      // RetryableError's constructor accepts (message, { retryAfter }).
      // Cause is attached after construction (the constructor does not
      // forward it). retryAfter is stored as a Date in the VM realm.
      const Cls = (globalThis as any)[
        Symbol.for('@workflow/errors//RetryableError')
      ];
      const retryAfter = new Date(value.retryAfter);
      let error: Error;
      if (typeof Cls === 'function') {
        error = new Cls(value.message, { retryAfter });
      } else {
        error = new Error(value.message);
        error.name = 'RetryableError';
        (error as any).retryAfter = retryAfter;
      }
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) (error as any).cause = (value as any).cause;
      return error;
    },
    SyntaxError: makeNamedErrorSubclassReviver('SyntaxError'),
    TypeError: makeNamedErrorSubclassReviver('TypeError'),
    URIError: makeNamedErrorSubclassReviver('URIError'),
    Error: (value) => {
      const error = new Error(value.message);
      error.name = value.name;
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) (error as any).cause = (value as any).cause;
      return error;
    },
    Float32Array: (value: string) => new Float32Array(reviveArrayBuffer(value)),
    Float64Array: (value: string) => new Float64Array(reviveArrayBuffer(value)),
    Int8Array: (value: string) => new Int8Array(reviveArrayBuffer(value)),
    Int16Array: (value: string) => new Int16Array(reviveArrayBuffer(value)),
    Int32Array: (value: string) => new Int32Array(reviveArrayBuffer(value)),
    Map: (value) => new Map(value),
    RegExp: (value) => new RegExp(value.source, value.flags),
    Set: (value) => new Set(value),
    URL: (value) => new URL(value),
    WorkflowFunction: (value) =>
      Object.assign(
        () => {
          throw new Error(
            'Workflow functions cannot be called directly. Use start() to invoke them.'
          );
        },
        { workflowId: value.workflowId }
      ),
    URLSearchParams: (value) => new URLSearchParams(value === '.' ? '' : value),
    Uint8Array: (value: string) => new Uint8Array(reviveArrayBuffer(value)),
    Uint8ClampedArray: (value: string) =>
      new Uint8ClampedArray(reviveArrayBuffer(value)),
    Uint16Array: (value: string) => new Uint16Array(reviveArrayBuffer(value)),
    Uint32Array: (value: string) => new Uint32Array(reviveArrayBuffer(value)),
    // Web API types — revived as plain objects in the VM since the real
    // constructors (Headers, Request, Response) are not available in QuickJS.
    // The workflow code can access the properties but not call Web API methods.
    Headers: (value) => {
      return new (globalThis as any).Headers(value);
    },
    Request: (value: any) => {
      const Req = (globalThis as any).Request;
      if (Req) {
        value.json = Req.prototype.json;
        value.text = Req.prototype.text;
        value.arrayBuffer = Req.prototype.arrayBuffer;
      }
      // Carry over the webhook response writable stream to the symbol property
      if (value.responseWritable) {
        value[Symbol.for('WEBHOOK_RESPONSE_WRITABLE')] = value.responseWritable;
      }
      return value;
    },
    Response: (value: any) => {
      // Don't use Object.setPrototypeOf — devalue continues to set properties
      // on the object after the reviver runs, and getter-only properties
      // (like 'ok') on the prototype would cause "no setter" errors.
      // Instead, copy methods directly onto the object.
      const Resp = (globalThis as any).Response;
      if (Resp) {
        value.json = Resp.prototype.json;
        value.text = Resp.prototype.text;
        value.arrayBuffer = Resp.prototype.arrayBuffer;
        if (Resp.prototype.bytes) value.bytes = Resp.prototype.bytes;
        if (Resp.prototype.clone) value.clone = Resp.prototype.clone;
      }
      value._body = value.body;
      value.ok = value.status >= 200 && value.status < 300;
      value.bodyUsed = false;
      return value;
    },
    ReadableStream: (value) => {
      const RS = (globalThis as any).ReadableStream;
      const stream = Object.create(RS ? RS.prototype : {});
      if (value && 'bodyInit' in value) {
        // Body from Response/Request constructor — store the raw data
        stream[Symbol.for('BODY_INIT')] = value.bodyInit;
      } else if (value && 'name' in value) {
        // Named stream reference — preserve the name/type for re-serialization.
        // Streams are opaque pointers in the VM — they can be passed to steps
        // but not consumed directly.
        stream[Symbol.for('WORKFLOW_STREAM_NAME')] = value.name;
        if (value.type) stream[Symbol.for('WORKFLOW_STREAM_TYPE')] = value.type;
      }
      return stream;
    },
    WritableStream: (value) => {
      const WS = (globalThis as any).WritableStream;
      const stream = Object.create(WS ? WS.prototype : {});
      if (value && 'name' in value) {
        stream[Symbol.for('WORKFLOW_STREAM_NAME')] = value.name;
      }
      return stream;
    },
  };
}
