/**
 * Host-side serialization for the QuickJS engine.
 *
 * Implements the workflow wire codec (format-prefixed devalue, identical to
 * `codec-devalue-vm.ts` / the node:vm engine's workflow-mode codec) as
 * host code operating on `JSValueHandle`s, using devalue 5.9's pluggable
 * operations (quickjs-wasi's host-side introspection primitives underneath).
 * The serde bundle previously evaluated inside the VM is gone: guest values
 * are read and built through handles, so no serializer code lives in — or
 * can be tampered with from — the guest realm.
 *
 * Side-effect discipline mirrors the node:vm engine's hardened codec
 * (serialization/hardened.ts):
 *
 * - classification is by engine brand (`classId` against boot-captured
 *   samples, `isError`, `isProxy`), never `instanceof` or
 *   `Symbol.toStringTag`;
 * - extraction goes through intrinsics captured at boot (before any user
 *   code runs) invoked with explicit receivers, or through own-property
 *   descriptor reads — patched prototypes and inherited accessors never
 *   run;
 * - the only guest code serialization can execute is the same code the
 *   previous in-VM codec executed by contract: a class's static
 *   `WORKFLOW_SERIALIZE` method, a step proxy's `__closureVarsFn`, and
 *   `WORKFLOW_USE_STEP` / `WORKFLOW_DESERIALIZE` on revival.
 *
 * Wire-format parity with the previous in-VM codec is REQUIRED and covered
 * by tests: event logs written by either codec must be readable by the
 * other (steps serialized by the node runtime feed VM revival and vice
 * versa).
 *
 * Hybrid value space: reducers return host shapes (plain objects, strings,
 * numbers) whose leaves may be guest handles — exactly how the node:vm
 * codec mixes host shapes with sandbox-realm leaves. Every stringify
 * operation therefore dispatches on `JSValueHandle` and falls back to
 * devalue's default host operations for host values. Parse operations
 * always build guest values, so the parse side is handle-only.
 */

import {
  defaultStringifyOperations,
  filterArrayIndices,
  type ParseOperations,
  parse,
  type StringifyOperations,
  stringify,
} from 'devalue';
import { JSValueHandle, type QuickJS } from 'quickjs-wasi';
import { SerializationFormat } from '../serialization/types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FORMAT_PREFIX_LENGTH = 4;

// ---- base64 (host-side; wire-compatible with the old in-VM btoa path) ----

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '.';
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64'
  );
}

function base64ToBytes(value: string): Uint8Array {
  if (value === '.') return new Uint8Array(0);
  return new Uint8Array(Buffer.from(value, 'base64'));
}

// ---- boot-time captures ----

/** devalue tags decided by engine class id, sampled at boot. */
const BRANDED_SAMPLES = `({
  Number: new Number(0),
  String: new String(''),
  Boolean: new Boolean(false),
  BigInt: Object(0n),
  Date: new Date(0),
  RegExp: /x/,
  Array: [],
  Set: new Set(),
  Map: new Map(),
  ArrayBuffer: new ArrayBuffer(0),
  DataView: new DataView(new ArrayBuffer(0)),
  Int8Array: new Int8Array(0),
  Uint8Array: new Uint8Array(0),
  Uint8ClampedArray: new Uint8ClampedArray(0),
  Int16Array: new Int16Array(0),
  Uint16Array: new Uint16Array(0),
  Int32Array: new Int32Array(0),
  Uint32Array: new Uint32Array(0),
  Float32Array: new Float32Array(0),
  Float64Array: new Float64Array(0),
  BigInt64Array: new BigInt64Array(0),
  BigUint64Array: new BigUint64Array(0),
})`;

/**
 * Intrinsics needed for reading and building, captured from the guest realm
 * at serde creation (which the runtime does right after evaluating the
 * bootstrap, before the workflow bundle). Held only on the host: later
 * patching inside the VM cannot influence serialization.
 *
 * Globals installed by the extensions/bootstrap (Headers, Request,
 * Response, ReadableStream, WritableStream, URL, URLSearchParams,
 * DOMException, __WorkflowAbortSignal) are captured defensively — absent
 * ones yield `undefined` and their reducers simply never match, exactly
 * like the old in-VM reducers' `globalThis.X` probes.
 */
/**
 * Identity signature of every value CAPTURE_INTRINSICS would capture —
 * used by the baseline-snapshot hydrate gate (quickjs-runtime.ts) to
 * detect a bundle whose module scope REPLACED a serialization intrinsic
 * (e.g. a Date.prototype.toISOString polyfill). The serde on the
 * restore path captures intrinsics from the restored heap — i.e. AFTER
 * module scope ran — so a replaced intrinsic would silently diverge
 * serialization from the fresh path (which captures before user code).
 * Comparing the signature before and after bundle eval catches every
 * replacement; in-place mutation of a captured function's own
 * properties is not detectable this way, but it doesn't change the
 * function's behavior and carries the same (accepted) risk on every
 * path. Missing captures (absent extension globals) signature as -1.
 */
export function captureIntrinsicsSignature(vm: QuickJS): number[] {
  using captured = vm.evalCode(CAPTURE_INTRINSICS);
  const signature: number[] = [];
  for (const name of captured.getOwnPropertyNames()) {
    // Entries the capture expression CREATES (guest helper closures) get
    // a fresh identity on every eval — comparing them would make the
    // gate trip unconditionally. They cannot be replaced by user code
    // (each serde capture rebuilds its own), so they carry no drift risk.
    if (
      name === 'makeSparseArray' ||
      name === 'makeThunk' ||
      name === 'hasOwnCall'
    ) {
      continue;
    }
    using handle = captured.getProp(name);
    signature.push(
      handle.isUndefined || handle.isNull
        ? -1
        : typeof handle.identity === 'number'
          ? handle.identity
          : -1
    );
  }
  return signature;
}

const CAPTURE_INTRINSICS = `(() => {
  const descriptor = (object, key) =>
    Object.getOwnPropertyDescriptor(object, key);
  const getter = (object, key) => {
    const d = descriptor(object, key);
    return d && d.get;
  };
  const TypedArray = Object.getPrototypeOf(Int8Array.prototype);
  const maybeProto = (Cls) => (Cls ? Cls.prototype : undefined);
  const g = globalThis;

  return {
    // --- reading (stringify) ---
    dateGetTime: Date.prototype.getTime,
    dateToISOString: Date.prototype.toISOString,
    regExpSource: getter(RegExp.prototype, 'source'),
    regExpFlags: getter(RegExp.prototype, 'flags'),
    numberValueOf: Number.prototype.valueOf,
    stringValueOf: String.prototype.valueOf,
    booleanValueOf: Boolean.prototype.valueOf,
    bigIntValueOf: BigInt.prototype.valueOf,
    bigIntToString: BigInt.prototype.toString,
    setForEach: Set.prototype.forEach,
    mapForEach: Map.prototype.forEach,
    headersForEach: g.Headers ? g.Headers.prototype.forEach : undefined,
    urlHref: g.URL ? getter(g.URL.prototype, 'href') : undefined,
    urlSearchParamsToString: g.URLSearchParams
      ? g.URLSearchParams.prototype.toString
      : undefined,
    urlSearchParamsSize: g.URLSearchParams
      ? getter(g.URLSearchParams.prototype, 'size')
      : undefined,
    viewBuffer: getter(TypedArray, 'buffer'),
    viewByteOffset: getter(TypedArray, 'byteOffset'),
    viewByteLength: getter(TypedArray, 'byteLength'),
    viewLength: getter(TypedArray, 'length'),
    dataViewBuffer: getter(DataView.prototype, 'buffer'),
    dataViewByteOffset: getter(DataView.prototype, 'byteOffset'),
    dataViewByteLength: getter(DataView.prototype, 'byteLength'),
    arrayBufferByteLength: getter(ArrayBuffer.prototype, 'byteLength'),
    objectPrototype: Object.prototype,
    errorPrototype: Error.prototype,
    domExceptionPrototype: maybeProto(g.DOMException),
    headersPrototype: maybeProto(g.Headers),
    requestPrototype: maybeProto(g.Request),
    responsePrototype: maybeProto(g.Response),
    readableStreamPrototype: maybeProto(g.ReadableStream),
    writableStreamPrototype: maybeProto(g.WritableStream),
    urlPrototype: maybeProto(g.URL),
    urlSearchParamsPrototype: maybeProto(g.URLSearchParams),

    // --- building (parse) ---
    Date, RegExp, Set, Map, Array, Object, DataView,
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array,
    Error,
    AggregateError: g.AggregateError,
    EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
    DOMException: g.DOMException,
    Headers: g.Headers,
    Request: g.Request,
    Response: g.Response,
    ReadableStream: g.ReadableStream,
    WritableStream: g.WritableStream,
    URL: g.URL,
    URLSearchParams: g.URLSearchParams,
    setAdd: Set.prototype.add,
    mapSet: Map.prototype.set,
    objectCreate: Object.create,
    defineProperty: Object.defineProperty,
    jsonStringify: JSON.stringify,
    objectKeys: Object.keys,
    dateNow: Date.now,
    hasOwnCall: (o, k) => Object.prototype.hasOwnProperty.call(o, k),
    functionBind: Function.prototype.bind,
    makeSparseArray: (length) => {
      const array = [];
      array[4294967294] = undefined;
      delete array[4294967294];
      array.length = length;
      return array;
    },
    // Builds the closure-vars thunk a revived step proxy carries. Must be a
    // guest closure (the proxy stores and later calls it from guest code).
    makeThunk: (vars) => () => vars,
  };
})()`;

/**
 * Well-known symbols the reducers/revivers read or stamp, captured as guest
 * symbol handles so descriptor reads/writes can be keyed on them.
 */
const SYMBOL_NAMES = [
  'WORKFLOW_ABORT_STREAM_NAME',
  'WORKFLOW_ABORT_HOOK_TOKEN',
  'BODY_INIT',
  'WORKFLOW_STREAM_NAME',
  'WORKFLOW_STREAM_TYPE',
  'WORKFLOW_STREAM_FRAMING',
  'WORKFLOW_STREAM_SERVER_RUN_ID',
  'WORKFLOW_STREAM_SERVER_DEPLOYMENT_ID',
  'WEBHOOK_RESPONSE_WRITABLE',
  'WORKFLOW_USE_STEP',
  'workflow-serialize', // @workflow/serde WORKFLOW_SERIALIZE
  'workflow-deserialize', // @workflow/serde WORKFLOW_DESERIALIZE
  'workflow-class-registry',
  '@workflow/errors//FatalError',
  '@workflow/errors//HookConflictError',
  '@workflow/errors//RetryableError',
  '@workflow/errors//RuntimeDecryptionError',
] as const;
type SymbolName = (typeof SYMBOL_NAMES)[number];

export interface QuickJSSerde {
  /** Serialize a guest value handle to format-prefixed wire bytes. */
  serialize(value: JSValueHandle): Uint8Array;
  /** Build a guest value in the VM from format-prefixed wire bytes. */
  deserialize(data: Uint8Array): JSValueHandle;
  /**
   * The reducer names this codec applies, in registration order. Exposed
   * so tests can assert exhaustiveness against the shared value-space
   * codec (codec-devalue-vm) — a reducer added there but not here would
   * otherwise silently round-trip values as plain objects.
   */
  reducerKeys: readonly string[];
  /** Reviver names, for the same exhaustiveness check. */
  reviverKeys: readonly string[];
  dispose(): void;
}

/**
 * Create the host-side serde for a VM. Must be called after the runtime
 * bootstrap has been evaluated (so bootstrap-installed globals are
 * capturable) and before the workflow bundle runs.
 */
export function createQuickJSSerde(vm: QuickJS): QuickJSSerde {
  const disposables: JSValueHandle[] = [];
  const keep = (handle: JSValueHandle): JSValueHandle => {
    disposables.push(handle);
    return handle;
  };
  const isHandle = (value: unknown): value is JSValueHandle =>
    value instanceof JSValueHandle;

  // --- boot capture ---

  const tagByClassId = new Map<number, string>();
  {
    const samples = vm.evalCode(BRANDED_SAMPLES);
    try {
      for (const tag of samples.getOwnPropertyNames()) {
        const sample = samples.getProp(tag);
        tagByClassId.set(sample.classId, tag);
        sample.dispose();
      }
    } finally {
      samples.dispose();
    }
  }

  const intrinsics = keep(vm.evalCode(CAPTURE_INTRINSICS));
  const at = (name: string): JSValueHandle => keep(intrinsics.getProp(name));
  /** Absent captures (extension/bootstrap global not installed). */
  const optional = (name: string): JSValueHandle | undefined => {
    const handle = at(name);
    return handle.isUndefined ? undefined : handle;
  };

  const i = {
    dateGetTime: at('dateGetTime'),
    dateToISOString: at('dateToISOString'),
    regExpSource: at('regExpSource'),
    regExpFlags: at('regExpFlags'),
    numberValueOf: at('numberValueOf'),
    stringValueOf: at('stringValueOf'),
    booleanValueOf: at('booleanValueOf'),
    bigIntValueOf: at('bigIntValueOf'),
    bigIntToString: at('bigIntToString'),
    setForEach: at('setForEach'),
    mapForEach: at('mapForEach'),
    headersForEach: optional('headersForEach'),
    urlHref: optional('urlHref'),
    urlSearchParamsToString: optional('urlSearchParamsToString'),
    urlSearchParamsSize: optional('urlSearchParamsSize'),
    viewBuffer: at('viewBuffer'),
    viewByteOffset: at('viewByteOffset'),
    viewByteLength: at('viewByteLength'),
    viewLength: at('viewLength'),
    dataViewBuffer: at('dataViewBuffer'),
    dataViewByteOffset: at('dataViewByteOffset'),
    dataViewByteLength: at('dataViewByteLength'),
    arrayBufferByteLength: at('arrayBufferByteLength'),
    objectPrototype: at('objectPrototype'),
    errorPrototype: at('errorPrototype'),
    domExceptionPrototype: optional('domExceptionPrototype'),
    headersPrototype: optional('headersPrototype'),
    requestPrototype: optional('requestPrototype'),
    responsePrototype: optional('responsePrototype'),
    readableStreamPrototype: optional('readableStreamPrototype'),
    writableStreamPrototype: optional('writableStreamPrototype'),
    urlPrototype: optional('urlPrototype'),
    urlSearchParamsPrototype: optional('urlSearchParamsPrototype'),
    Date: at('Date'),
    RegExp: at('RegExp'),
    Set: at('Set'),
    Map: at('Map'),
    Array: at('Array'),
    Object: at('Object'),
    Error: at('Error'),
    AggregateError: optional('AggregateError'),
    DOMException: optional('DOMException'),
    Headers: optional('Headers'),
    ReadableStream: optional('ReadableStream'),
    WritableStream: optional('WritableStream'),
    URL: optional('URL'),
    URLSearchParams: optional('URLSearchParams'),
    setAdd: at('setAdd'),
    mapSet: at('mapSet'),
    objectCreate: at('objectCreate'),
    defineProperty: at('defineProperty'),
    jsonStringify: at('jsonStringify'),
    objectKeys: at('objectKeys'),
    dateNow: at('dateNow'),
    hasOwnCall: at('hasOwnCall'),
    functionBind: at('functionBind'),
    makeSparseArray: at('makeSparseArray'),
    makeThunk: at('makeThunk'),
  };

  const errorConstructors = new Map<string, JSValueHandle>();
  for (const name of [
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
  ]) {
    errorConstructors.set(name, at(name));
  }

  const typedArrayConstructors = new Map<string, JSValueHandle>();
  for (const name of [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'DataView',
  ]) {
    typedArrayConstructors.set(name, at(name));
  }

  const symbols = new Map<SymbolName, JSValueHandle>();
  for (const name of SYMBOL_NAMES) {
    symbols.set(name, keep(vm.evalCode(`Symbol.for(${JSON.stringify(name)})`)));
  }
  const sym = (name: SymbolName): JSValueHandle => {
    const handle = symbols.get(name);
    if (!handle) throw new Error(`unknown captured symbol: ${name}`);
    return handle;
  };

  // --- handle helpers ---

  const call = (
    fn: JSValueHandle,
    thisValue: JSValueHandle,
    ...args: JSValueHandle[]
  ): JSValueHandle => vm.callFunction(fn, thisValue, ...args);

  const invoke = (fn: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle =>
    vm.callFunction(fn, vm.undefined, ...args);

  /**
   * NUL-safe host string from a guest string handle. `handle.toString()`
   * routes through `JS_ToCString`, which is NUL-terminated — a guest
   * string containing U+0000 arrives silently truncated. Detection is
   * cheap: `handle.length` is the true guest length (UTF-16 code units),
   * so a mismatch against the extracted string's length means data was
   * lost. The recovery path escapes the string INSIDE the VM with the
   * captured `JSON.stringify` (the escaped form is NUL-free by
   * construction, so its own extraction cannot truncate) and parses it
   * host-side. NUL-free strings — the overwhelming majority — pay only
   * the `.length` read.
   */
  const guestString = (handle: JSValueHandle): string => {
    const fast = handle.toString();
    if (fast.length === handle.length) return fast;
    return JSON.parse(
      invoke(i.jsonStringify, handle).consume((h) => h.toString())
    ) as string;
  };

  /**
   * Guest own-property check through the handle's introspection method.
   * MUST NOT be replaced with `Object.hasOwn`, which would interrogate the
   * host JSValueHandle wrapper object (always false) instead of the guest
   * value — biome's noPrototypeBuiltins auto-fix does exactly that, which
   * is why this is centralized here with the suppression.
   */
  const guestHasOwn = (handle: JSValueHandle, key: string): boolean =>
    // biome-ignore lint/suspicious/noPrototypeBuiltins: JSValueHandle.hasOwnProperty is quickjs-wasi's guest-side introspection API, not Object.prototype.hasOwnProperty
    handle.hasOwnProperty(key);

  /**
   * Own data-property read. Returns undefined for absent properties AND for
   * accessor properties — an inherited or own getter is never invoked
   * (matching the hardened node:vm codec's descriptor-based reads).
   */
  const own = (
    target: JSValueHandle,
    key: string | JSValueHandle
  ): JSValueHandle | undefined => {
    const descriptor = target.getOwnPropertyDescriptor(key as string);
    if (!descriptor) return undefined;
    descriptor.get?.dispose();
    descriptor.set?.dispose();
    return descriptor.value;
  };

  /**
   * Data-property read following the prototype chain (the safe analogue of
   * `value.name` on an Error instance, where `name`/`message` live on the
   * prototype). Accessors anywhere on the chain are skipped, not invoked.
   */
  const chained = (
    target: JSValueHandle,
    key: string | JSValueHandle
  ): JSValueHandle | undefined => {
    let current: JSValueHandle | undefined;
    let owned = false; // whether `current` is ours to dispose
    let cursor = target;
    for (let depth = 0; depth < 32; depth++) {
      const found = own(cursor, key);
      if (found) {
        if (owned) (cursor as JSValueHandle).dispose();
        return found;
      }
      const proto = cursor.getPrototypeOf();
      if (owned) (cursor as JSValueHandle).dispose();
      if (proto.isNull || proto.isUndefined) {
        proto.dispose();
        return undefined;
      }
      cursor = proto;
      owned = true;
      current = proto;
    }
    if (owned && current) current.dispose();
    return undefined;
  };

  /** Host string from a data property (own-or-chain), or undefined. */
  const chainedString = (
    target: JSValueHandle,
    key: string | JSValueHandle
  ): string | undefined => {
    const handle = chained(target, key);
    if (!handle) return undefined;
    const result = handle.isString ? guestString(handle) : undefined;
    handle.dispose();
    return result;
  };

  const ownString = (
    target: JSValueHandle,
    key: string | JSValueHandle
  ): string | undefined => {
    const handle = own(target, key);
    if (!handle) return undefined;
    const result = handle.isString ? guestString(handle) : undefined;
    handle.dispose();
    return result;
  };

  /**
   * Whether `handle` has `prototypeHandle` anywhere on its prototype chain —
   * the trap-free analogue of `instanceof` (which would fire
   * `Symbol.hasInstance`).
   */
  const hasPrototype = (
    handle: JSValueHandle,
    prototypeHandle: JSValueHandle | undefined
  ): boolean => {
    if (!prototypeHandle) return false;
    let cursor = handle.getPrototypeOf();
    for (let depth = 0; depth < 32; depth++) {
      if (cursor.isNull || cursor.isUndefined) {
        cursor.dispose();
        return false;
      }
      if (cursor.identity === prototypeHandle.identity) {
        cursor.dispose();
        return true;
      }
      const next = cursor.getPrototypeOf();
      cursor.dispose();
      cursor = next;
    }
    cursor.dispose();
    return false;
  };

  /** `Object.defineProperty` write, immune to inherited setters. */
  const define = (
    target: JSValueHandle,
    key: string | JSValueHandle,
    value: JSValueHandle
  ): void => {
    const descriptor = vm.newObject();
    try {
      descriptor.setProp('value', value);
      descriptor.setProp('writable', vm.true);
      descriptor.setProp('enumerable', vm.true);
      descriptor.setProp('configurable', vm.true);
      if (typeof key === 'string') {
        const keyHandle = vm.newString(key);
        try {
          call(
            i.defineProperty,
            vm.undefined,
            target,
            keyHandle,
            descriptor
          ).dispose();
        } finally {
          keyHandle.dispose();
        }
      } else {
        call(i.defineProperty, vm.undefined, target, key, descriptor).dispose();
      }
    } finally {
      descriptor.dispose();
    }
  };

  const newGuestString = (value: string): JSValueHandle => vm.newString(value);

  /** Collect Set values / Map entries via captured forEach. */
  const collect = (
    forEach: JSValueHandle,
    collection: JSValueHandle,
    arity: 1 | 2
  ): unknown[] => {
    const collected: unknown[] = [];
    const visitor = vm.newEphemeralFunction(
      (value: JSValueHandle, key: JSValueHandle) => {
        // dup(): the visitor's own arg handles are borrowed (C-owned,
        // scope-exempt as of quickjs-wasi 3.3.1); the dups are owned
        // references, scope-tracked and swept at the pass boundary.
        collected.push(arity === 1 ? value.dup() : [key.dup(), value.dup()]);
        return vm.undefined;
      }
    );
    try {
      call(forEach, collection, visitor).dispose();
    } finally {
      visitor.dispose();
    }
    return collected;
  };

  /** Copy a typed array / DataView's viewed bytes to the host. */
  const viewBytes = (handle: JSValueHandle): Uint8Array => {
    const isDataView = handle.isDataView;
    const buffer = call(isDataView ? i.dataViewBuffer : i.viewBuffer, handle);
    try {
      const byteOffset = call(
        isDataView ? i.dataViewByteOffset : i.viewByteOffset,
        handle
      ).consume((h) => h.toNumber());
      const byteLength = call(
        isDataView ? i.dataViewByteLength : i.viewByteLength,
        handle
      ).consume((h) => h.toNumber());
      const bytes = new Uint8Array(buffer.toArrayBuffer());
      return bytes.subarray(byteOffset, byteOffset + byteLength);
    } finally {
      buffer.dispose();
    }
  };

  const tagOfHandle = (handle: JSValueHandle): string => {
    if (handle.isProxy) return 'Object';
    return tagByClassId.get(handle.classId) ?? 'Object';
  };

  // --- identity ---

  const identities = new Map<number, object>();
  const identityOf = (pointer: number): object => {
    let identity = identities.get(pointer);
    if (!identity) {
      identity = { pointer };
      identities.set(pointer, identity);
    }
    return identity;
  };

  const primitiveOf = (handle: JSValueHandle): unknown => {
    if (handle.isUndefined) return undefined;
    if (handle.isNull) return null;
    if (handle.isBool) return handle.toBoolean();
    if (handle.isNumber) return handle.toNumber();
    if (handle.isBigInt) return guestBigInt(handle);
    return guestString(handle);
  };

  /**
   * Extract a guest bigint via the captured `BigInt.prototype.toString` —
   * `handle.toBigInt()` truncates to 64 bits.
   */
  const guestBigInt = (handle: JSValueHandle): bigint =>
    BigInt(call(i.bigIntToString, handle).consume((h) => h.toString()));

  // --- hybrid stringify operations ---
  // Handles take the introspection path; host values (reducer outputs)
  // fall back to devalue's defaults.

  const d = defaultStringifyOperations;

  const stringifyOperations: StringifyOperations = {
    identify: (value) => {
      if (!isHandle(value)) return d.identify(value);
      const pointer = value.identity;
      if (pointer === 0 || value.isString) return primitiveOf(value);
      return identityOf(pointer);
    },
    typeOf: (value) => {
      if (!isHandle(value)) return d.typeOf(value);
      if (value.isNull) return 'null';
      return value.typeof as ReturnType<StringifyOperations['typeOf']>;
    },
    toPrimitive: (value) => (isHandle(value) ? primitiveOf(value) : value),
    tagOf: (value) => (isHandle(value) ? tagOfHandle(value) : d.tagOf(value)),
    isThenable: (value) =>
      isHandle(value) ? value.isPromise : d.isThenable(value),
    toPromise: async (value) => {
      if (!isHandle(value)) return d.toPromise(value);
      const settled = await vm.resolvePromise(value);
      if ('error' in settled) throw settled.error;
      return settled.value;
    },
    unbox: (value) => {
      if (!isHandle(value)) return d.unbox(value);
      switch (tagOfHandle(value)) {
        case 'Number':
          return call(i.numberValueOf, value);
        case 'String':
          return call(i.stringValueOf, value);
        case 'Boolean':
          return call(i.booleanValueOf, value);
        default:
          return call(i.bigIntValueOf, value);
      }
    },
    toISOString: (value) => {
      if (!isHandle(value)) return d.toISOString(value);
      if (
        Number.isNaN(call(i.dateGetTime, value).consume((h) => h.toNumber()))
      ) {
        return '';
      }
      return call(i.dateToISOString, value).consume((h) => h.toString());
    },
    toStringValue: (value) => {
      if (!isHandle(value)) return d.toStringValue(value);
      // URL / URLSearchParams are matched by workflow reducers before
      // devalue's native handling, and Temporal doesn't exist in the VM, so
      // this is unreachable in practice. Refuse rather than invoke guest
      // `toString`.
      throw new Error(
        `no captured string conversion for ${tagOfHandle(value)} in the VM`
      );
    },
    regExpInfo: (value) => {
      if (!isHandle(value)) return d.regExpInfo(value);
      return {
        source: call(i.regExpSource, value).consume(guestString),
        flags: call(i.regExpFlags, value).consume(guestString),
      };
    },
    valuesOf: (value) =>
      isHandle(value) ? collect(i.setForEach, value, 1) : d.valuesOf(value),
    entriesOf: (value) =>
      isHandle(value)
        ? (collect(i.mapForEach, value, 2) as Iterable<[unknown, unknown]>)
        : d.entriesOf(value),
    viewInfo: (value) => {
      if (!isHandle(value)) return d.viewInfo(value);
      const isDataView = value.isDataView;
      const buffer = call(isDataView ? i.dataViewBuffer : i.viewBuffer, value);
      const info = {
        buffer,
        byteOffset: call(
          isDataView ? i.dataViewByteOffset : i.viewByteOffset,
          value
        ).consume((h) => h.toNumber()),
        byteLength: call(
          isDataView ? i.dataViewByteLength : i.viewByteLength,
          value
        ).consume((h) => h.toNumber()),
        bufferByteLength: call(i.arrayBufferByteLength, buffer).consume((h) =>
          h.toNumber()
        ),
        length: 0,
      };
      if (!isDataView) {
        info.length = call(i.viewLength, value).consume((h) => h.toNumber());
      }
      return info;
    },
    toArrayBuffer: (value) =>
      isHandle(value) ? value.toArrayBuffer() : d.toArrayBuffer(value),
    lengthOf: (value) => {
      if (!isHandle(value)) return d.lengthOf(value);
      const length = own(value, 'length');
      return length?.consume((h) => h.toNumber()) ?? 0;
    },
    hasOwn: (value, key) => {
      if (!isHandle(value)) return d.hasOwn(value, key);
      if (typeof key === 'string' && key.includes('\u0000')) {
        // C-string key APIs truncate at NUL — check inside the guest.
        const keyHandle = vm.newString(key);
        try {
          return invoke(i.hasOwnCall, value, keyHandle).consume((h) =>
            h.toBoolean()
          );
        } finally {
          keyHandle.dispose();
        }
      }
      return guestHasOwn(value, String(key));
    },
    indicesOf: (value) =>
      isHandle(value) ? filterArrayIndices(value.keys()) : d.indicesOf(value),
    shapeOf: (value) => {
      if (!isHandle(value)) return d.shapeOf(value);
      if (value.isProxy) return { kind: 'not-plain' as const };
      const prototype = value.getPrototypeOf();
      try {
        const isPlain =
          prototype.isNull || prototype.identity === i.objectPrototype.identity;
        if (!isPlain) return { kind: 'not-plain' as const };
        const keys: string[] = [];
        for (const key of value.getOwnPropertyKeys()) {
          if (typeof key !== 'string') {
            const enumerable =
              value.getOwnPropertyDescriptor(key)?.enumerable ?? false;
            key.dispose();
            if (enumerable) return { kind: 'symbol-keys' as const };
            continue;
          }
          if (value.propertyIsEnumerable(key)) keys.push(key);
        }
        // NUL-key guard: the enumeration above yields HOST strings that
        // crossed `JS_ToCString`, so a key containing U+0000 arrives
        // truncated — either dropping it (the truncated name fails the
        // propertyIsEnumerable probe) or colliding with a sibling key. A
        // single guest `Object.keys` call exposes both shapes cheaply:
        // a count mismatch or a duplicate in the fast list means at
        // least one key was mangled, and the guest array (whose entries
        // are handles) is then re-extracted NUL-safely via guestString.
        const guestKeys = invoke(i.objectKeys, value);
        try {
          const guestCount = guestKeys.length;
          if (
            keys.length !== guestCount ||
            new Set(keys).size !== keys.length
          ) {
            keys.length = 0;
            for (let idx = 0; idx < guestCount; idx++) {
              const keyHandle = guestKeys.getProp(String(idx));
              keys.push(guestString(keyHandle));
              keyHandle.dispose();
            }
          }
        } finally {
          guestKeys.dispose();
        }
        return {
          kind: prototype.isNull ? ('null-proto' as const) : ('plain' as const),
          keys,
        };
      } finally {
        prototype.dispose();
      }
    },
    get: (value, key) => {
      if (!isHandle(value)) return d.get(value, key);
      // A NUL-bearing key cannot be looked up through the C-string APIs
      // (the lookup name would truncate to the wrong key). Route it
      // through a guest string handle instead — `vm.newString` is
      // length-aware, and handle-keyed getProp performs a plain [[Get]]
      // (getters are invoked, matching the descriptor path's explicit
      // accessor invocation below).
      if (typeof key === 'string' && key.includes('\u0000')) {
        const keyHandle = vm.newString(key);
        try {
          return vm.getProp(value, keyHandle);
        } finally {
          keyHandle.dispose();
        }
      }
      const descriptor = value.getOwnPropertyDescriptor(String(key));
      if (!descriptor) return undefined;
      if (descriptor.get) {
        // Parity with the hardened node:vm codec: getters are invoked (full
        // compatibility with values whose shape depends on accessors), the
        // difference from `[[Get]]` being that this is an explicit, single
        // invocation of the accessor the descriptor names.
        const result = call(descriptor.get, value);
        descriptor.get.dispose();
        descriptor.set?.dispose();
        return result;
      }
      descriptor.set?.dispose();
      return descriptor.value;
    },
  };

  // --- workflow reducers (handle space) ---

  /** Host shape for error-family reduction; leaves may be handles. */
  const reduceErrorShape = (
    value: JSValueHandle
  ): { message: string; stack?: string; cause?: unknown } => {
    const shape: { message: string; stack?: string; cause?: unknown } = {
      message: chainedString(value, 'message') ?? '',
    };
    const stack = chainedString(value, 'stack');
    if (stack !== undefined) shape.stack = stack;
    if (guestHasOwn(value, 'cause')) {
      shape.cause = own(value, 'cause') ?? undefined;
    }
    return shape;
  };

  const namedErrorSubclassReducer =
    (subclassName: string) => (value: unknown) => {
      if (!isHandle(value) || !value.isError) return false;
      if (chainedString(value, 'name') !== subclassName) return false;
      return reduceErrorShape(value);
    };

  /** Own symbol-keyed data read returning a host string, or undefined. */
  const ownSymbolString = (
    value: JSValueHandle,
    name: SymbolName
  ): string | undefined => {
    const handle = own(value, sym(name));
    if (!handle) return undefined;
    const result = handle.isString ? guestString(handle) : undefined;
    handle.dispose();
    return result;
  };

  const reduceAbort = (value: JSValueHandle): unknown => {
    // streamName/hookToken live on the signal (or the controller's signal).
    const signal = own(value, 'signal');
    const holder = signal ?? value;
    const streamName =
      ownSymbolString(value, 'WORKFLOW_ABORT_STREAM_NAME') ??
      ownSymbolString(holder, 'WORKFLOW_ABORT_STREAM_NAME');
    const hookToken =
      ownSymbolString(value, 'WORKFLOW_ABORT_HOOK_TOKEN') ??
      ownSymbolString(holder, 'WORKFLOW_ABORT_HOOK_TOKEN');
    if (!streamName) {
      signal?.dispose();
      throw new Error('AbortController/AbortSignal stream name is not set');
    }
    const aborted =
      own(holder, 'aborted')?.consume((h) => h.toBoolean()) ?? false;
    const reason = aborted ? own(holder, 'reason') : undefined;
    if (signal && holder !== value) signal.dispose();
    return {
      streamName,
      hookToken,
      aborted,
      reason: aborted ? reason : undefined,
    };
  };

  const reducers: Record<string, (value: any) => any> = {
    // Order is wire-significant (first match wins) and mirrors
    // codec-devalue-vm.ts getReducersForMode('workflow') exactly.
    AbortController: (value) => {
      if (!isHandle(value) || value.typeof !== 'object' || value.isNull) {
        return false;
      }
      if (!guestHasOwn(value, 'signal')) return false;
      const hasStamp =
        ownSymbolString(value, 'WORKFLOW_ABORT_STREAM_NAME') !== undefined ||
        own(value, 'signal')?.consume(
          (signal) =>
            ownSymbolString(signal, 'WORKFLOW_ABORT_STREAM_NAME') !== undefined
        );
      if (!hasStamp) return false;
      return reduceAbort(value);
    },
    AbortSignal: (value) => {
      if (!isHandle(value) || value.typeof !== 'object' || value.isNull) {
        return false;
      }
      if (ownSymbolString(value, 'WORKFLOW_ABORT_STREAM_NAME') === undefined) {
        return false;
      }
      return reduceAbort(value);
    },
    Class: (value) => {
      if (!isHandle(value) || value.typeof !== 'function') return false;
      const classId = ownString(value, 'classId');
      if (classId === undefined) return false;
      return { classId };
    },
    Instance: (value) => {
      if (!isHandle(value) || value.typeof !== 'object' || value.isNull) {
        return false;
      }
      const cls = chained(value, 'constructor');
      if (!cls || cls.typeof !== 'function') {
        cls?.dispose();
        return false;
      }
      try {
        const serializeMethod = chained(cls, sym('workflow-serialize'));
        if (!serializeMethod || serializeMethod.typeof !== 'function') {
          serializeMethod?.dispose();
          return false;
        }
        try {
          const classId = chainedString(cls, 'classId');
          if (classId === undefined) {
            const name = chainedString(cls, 'name') ?? '<anonymous>';
            throw new Error(
              `Class "${name}" with Symbol(workflow-serialize) must have a static "classId" property.`
            );
          }
          // Guest code by contract: the class's own serializer runs, exactly
          // as it did under the in-VM codec.
          const data = call(serializeMethod, cls, value);
          return { classId, data };
        } finally {
          serializeMethod.dispose();
        }
      } finally {
        cls.dispose();
      }
    },
    StepFunction: (value) => {
      if (!isHandle(value) || value.typeof !== 'function') return false;
      const stepId = ownString(value, 'stepId');
      if (stepId === undefined) return false;
      const payload: {
        stepId: string;
        closureVars?: unknown;
        boundThis?: unknown;
        boundArgs?: unknown;
      } = { stepId };
      const closureVarsFn = own(value, '__closureVarsFn');
      if (closureVarsFn) {
        if (closureVarsFn.typeof === 'function') {
          // Guest code by contract (same as the in-VM codec).
          const closureVars = call(closureVarsFn, vm.undefined);
          if (!closureVars.isUndefined) payload.closureVars = closureVars;
          else closureVars.dispose();
        }
        closureVarsFn.dispose();
      }
      if (guestHasOwn(value, '__boundThis')) {
        payload.boundThis = own(value, '__boundThis');
      }
      const boundArgs = own(value, '__boundArgs');
      if (boundArgs) {
        const length =
          own(boundArgs, 'length')?.consume((h) => h.toNumber()) ?? 0;
        if (boundArgs.isArray && length > 0) payload.boundArgs = boundArgs;
        else boundArgs.dispose();
      }
      return payload;
    },
    ArrayBuffer: (value) => {
      if (!isHandle(value) || tagOfHandle(value) !== 'ArrayBuffer') {
        return false;
      }
      return bytesToBase64(new Uint8Array(value.toArrayBuffer()));
    },
    BigInt: (value) => {
      if (!isHandle(value) || !value.isBigInt) return false;
      return guestBigInt(value).toString();
    },
    BigInt64Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'BigInt64Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    BigUint64Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'BigUint64Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    Date: (value) => {
      if (!isHandle(value) || tagOfHandle(value) !== 'Date') return false;
      const time = call(i.dateGetTime, value).consume((h) => h.toNumber());
      if (Number.isNaN(time)) return '.';
      return call(i.dateToISOString, value).consume((h) => h.toString());
    },
    DOMException: (value) => {
      if (!isHandle(value) || !isHandle(value)) return false;
      if (
        !i.domExceptionPrototype ||
        !hasPrototype(value, i.domExceptionPrototype)
      ) {
        return false;
      }
      const shape = reduceErrorShape(value) as Record<string, unknown>;
      return {
        message: shape.message,
        name: chainedString(value, 'name'),
        stack: shape.stack,
        ...(Object.hasOwn(shape, 'cause') ? { cause: shape.cause } : {}),
      };
    },
    AggregateError: (value) => {
      if (!isHandle(value) || !value.isError) return false;
      if (chainedString(value, 'name') !== 'AggregateError') return false;
      const shape = reduceErrorShape(value) as Record<string, unknown>;
      return {
        message: shape.message,
        stack: shape.stack,
        errors: own(value, 'errors'),
        ...(Object.hasOwn(shape, 'cause') ? { cause: shape.cause } : {}),
      };
    },
    EvalError: namedErrorSubclassReducer('EvalError'),
    FatalError: namedErrorSubclassReducer('FatalError'),
    HookConflictError: (value) => {
      if (!isHandle(value) || !value.isError) return false;
      if (chainedString(value, 'name') !== 'HookConflictError') return false;
      const shape = reduceErrorShape(value) as Record<string, unknown>;
      const reduced: Record<string, unknown> = {
        message: shape.message,
        stack: shape.stack,
        token: own(value, 'token'),
      };
      const conflictingRunId = own(value, 'conflictingRunId');
      if (conflictingRunId && !conflictingRunId.isUndefined) {
        reduced.conflictingRunId = conflictingRunId;
      } else {
        conflictingRunId?.dispose();
      }
      if (Object.hasOwn(shape, 'cause')) reduced.cause = shape.cause;
      return reduced;
    },
    RangeError: namedErrorSubclassReducer('RangeError'),
    ReferenceError: namedErrorSubclassReducer('ReferenceError'),
    RetryableError: (value) => {
      if (!isHandle(value) || !value.isError) return false;
      if (chainedString(value, 'name') !== 'RetryableError') return false;
      const shape = reduceErrorShape(value) as Record<string, unknown>;
      // retryAfter is a guest Date (or string/number); normalize to an epoch
      // timestamp exactly like the in-VM reducer. The absent/invalid
      // fallback reads the GUEST clock (the deterministic replay clock at
      // the WASI layer), not the host wall clock: the in-VM reducer's
      // `Date.now()` was replay-stable by construction, and a host-side
      // `Date.now()` here would write different bytes on every replay of
      // the same value.
      let retryAfter = invoke(i.dateNow).consume((h) => h.toNumber()) + 1000;
      const raw = own(value, 'retryAfter');
      if (raw) {
        if (tagOfHandle(raw) === 'Date') {
          const t = call(i.dateGetTime, raw).consume((h) => h.toNumber());
          if (!Number.isNaN(t)) retryAfter = t;
        } else if (raw.isString || raw.isNumber) {
          const t = new Date(
            raw.isString ? raw.toString() : raw.toNumber()
          ).getTime();
          if (!Number.isNaN(t)) retryAfter = t;
        }
        raw.dispose();
      }
      const reduced: Record<string, unknown> = {
        message: shape.message,
        stack: shape.stack,
        retryAfter,
      };
      if (Object.hasOwn(shape, 'cause')) reduced.cause = shape.cause;
      return reduced;
    },
    RuntimeDecryptionError: (value) => {
      if (!isHandle(value) || !value.isError) return false;
      if (chainedString(value, 'name') !== 'RuntimeDecryptionError') {
        return false;
      }
      const shape = reduceErrorShape(value) as Record<string, unknown>;
      const reduced: Record<string, unknown> = {
        message: shape.message,
        stack: shape.stack,
      };
      const context = own(value, 'context');
      if (context && !context.isUndefined) reduced.context = context;
      else context?.dispose();
      if (Object.hasOwn(shape, 'cause')) reduced.cause = shape.cause;
      return reduced;
    },
    SyntaxError: namedErrorSubclassReducer('SyntaxError'),
    TypeError: namedErrorSubclassReducer('TypeError'),
    URIError: namedErrorSubclassReducer('URIError'),
    Error: (value) => {
      if (!isHandle(value) || !value.isError) return false;
      const shape = reduceErrorShape(value) as Record<string, unknown>;
      return {
        name: chainedString(value, 'name') ?? 'Error',
        message: shape.message,
        stack: shape.stack,
        ...(Object.hasOwn(shape, 'cause') ? { cause: shape.cause } : {}),
      };
    },
    Float32Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Float32Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    Float64Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Float64Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    Int8Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Int8Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    Int16Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Int16Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    Int32Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Int32Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    Map: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Map'
        ? collect(i.mapForEach, value, 2)
        : false,
    RegExp: (value) => {
      if (!isHandle(value) || tagOfHandle(value) !== 'RegExp') return false;
      return {
        source: call(i.regExpSource, value).consume(guestString),
        flags: call(i.regExpFlags, value).consume(guestString),
      };
    },
    Headers: (value) => {
      if (
        !isHandle(value) ||
        !i.headersPrototype ||
        !hasPrototype(value, i.headersPrototype) ||
        !i.headersForEach
      ) {
        return false;
      }
      // Headers.forEach yields (value, key); normalize to [key, value]
      // pairs of host strings, matching Array.from(headers).
      const entries: [string, string][] = [];
      const visitor = vm.newEphemeralFunction(
        (headerValue: JSValueHandle, headerKey: JSValueHandle) => {
          entries.push([guestString(headerKey), guestString(headerValue)]);
          return vm.undefined;
        }
      );
      try {
        call(i.headersForEach, value, visitor).dispose();
      } finally {
        visitor.dispose();
      }
      return entries;
    },
    Request: (value) => {
      if (!isHandle(value) || value.typeof !== 'object' || value.isNull) {
        return false;
      }
      const isRequest =
        (i.requestPrototype && hasPrototype(value, i.requestPrototype)) ||
        own(value, 'json')?.consume((h) => h.typeof === 'function');
      if (!isRequest) return false;
      const method = own(value, 'method');
      if (!method || !method.isString) {
        method?.dispose();
        return false;
      }
      const data: Record<string, unknown> = {
        method,
        url: own(value, 'url'),
        headers: own(value, 'headers'),
        body: own(value, 'body'),
        duplex: own(value, 'duplex'),
      };
      const responseWritable = own(value, sym('WEBHOOK_RESPONSE_WRITABLE'));
      if (responseWritable && !responseWritable.isUndefined) {
        data.responseWritable = responseWritable;
      } else {
        responseWritable?.dispose();
      }
      return data;
    },
    Response: (value) => {
      if (!isHandle(value) || value.typeof !== 'object' || value.isNull) {
        return false;
      }
      const isResponse =
        (i.responsePrototype && hasPrototype(value, i.responsePrototype)) ||
        chained(value, 'clone')?.consume((h) => h.typeof === 'function');
      if (!isResponse) return false;
      const status = own(value, 'status');
      if (!status || !status.isNumber) {
        status?.dispose();
        return false;
      }
      return {
        type: own(value, 'type'),
        url: own(value, 'url'),
        status,
        statusText: own(value, 'statusText'),
        headers: own(value, 'headers'),
        body: own(value, 'body'),
        redirected: own(value, 'redirected'),
      };
    },
    ReadableStream: (value) => {
      if (
        !isHandle(value) ||
        value.typeof !== 'object' ||
        value.isNull ||
        !i.readableStreamPrototype ||
        !hasPrototype(value, i.readableStreamPrototype)
      ) {
        return false;
      }
      const bodyInit = own(value, sym('BODY_INIT'));
      if (bodyInit && !bodyInit.isUndefined) {
        return { bodyInit };
      }
      bodyInit?.dispose();
      const name = ownSymbolString(value, 'WORKFLOW_STREAM_NAME');
      if (name) {
        const s: Record<string, unknown> = { name };
        const type = ownSymbolString(value, 'WORKFLOW_STREAM_TYPE');
        if (type) s.type = type;
        const framing = ownSymbolString(value, 'WORKFLOW_STREAM_FRAMING');
        if (framing) s.framing = framing;
        return s;
      }
      return { name: '__empty' };
    },
    WritableStream: (value) => {
      if (
        !isHandle(value) ||
        value.typeof !== 'object' ||
        value.isNull ||
        !i.writableStreamPrototype ||
        !hasPrototype(value, i.writableStreamPrototype)
      ) {
        return false;
      }
      const s: Record<string, unknown> = {
        name: ownSymbolString(value, 'WORKFLOW_STREAM_NAME') || '__empty',
      };
      const runId = ownSymbolString(value, 'WORKFLOW_STREAM_SERVER_RUN_ID');
      if (runId) s.runId = runId;
      const deploymentId = ownSymbolString(
        value,
        'WORKFLOW_STREAM_SERVER_DEPLOYMENT_ID'
      );
      if (deploymentId) s.deploymentId = deploymentId;
      return s;
    },
    Set: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Set'
        ? collect(i.setForEach, value, 1)
        : false,
    URL: (value) => {
      if (
        !isHandle(value) ||
        !i.urlPrototype ||
        !hasPrototype(value, i.urlPrototype) ||
        !i.urlHref
      ) {
        return false;
      }
      return call(i.urlHref, value).consume(guestString);
    },
    WorkflowFunction: (value) => {
      if (!isHandle(value) || value.typeof !== 'function') return false;
      const workflowId = ownString(value, 'workflowId');
      if (workflowId === undefined) return false;
      return { workflowId };
    },
    URLSearchParams: (value) => {
      if (
        !isHandle(value) ||
        !i.urlSearchParamsPrototype ||
        !hasPrototype(value, i.urlSearchParamsPrototype) ||
        !i.urlSearchParamsToString
      ) {
        return false;
      }
      const size = i.urlSearchParamsSize
        ? call(i.urlSearchParamsSize, value).consume((h) => h.toNumber())
        : Number.NaN;
      if (size === 0) return '.';
      return call(i.urlSearchParamsToString, value).consume((h) =>
        h.toString()
      );
    },
    Uint8Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Uint8Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    Uint8ClampedArray: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Uint8ClampedArray'
        ? bytesToBase64(viewBytes(value))
        : false,
    Uint16Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Uint16Array'
        ? bytesToBase64(viewBytes(value))
        : false,
    Uint32Array: (value) =>
      isHandle(value) && tagOfHandle(value) === 'Uint32Array'
        ? bytesToBase64(viewBytes(value))
        : false,
  };

  // --- parse operations (handle-only: everything is built in the VM) ---

  const parseOperations: ParseOperations = {
    fromPrimitive: (value) =>
      typeof value === 'bigint' ? vm.newBigInt(value) : vm.hostToHandle(value),
    fromISOString: (iso) => {
      const argument =
        iso === '' ? vm.newNumber(Number.NaN) : vm.newString(iso);
      try {
        return vm.construct(i.Date, argument);
      } finally {
        argument.dispose();
      }
    },
    fromStringValue: (tag, _string) => {
      throw new Error(`${tag} cannot be revived in the VM`);
    },
    fromArrayBuffer: (buffer) => vm.newArrayBuffer(buffer),
    fromRegExpInfo: (source, flags) => {
      const sourceHandle = vm.newString(source);
      try {
        if (!flags) return vm.construct(i.RegExp, sourceHandle);
        const flagsHandle = vm.newString(flags);
        try {
          return vm.construct(i.RegExp, sourceHandle, flagsHandle);
        } finally {
          flagsHandle.dispose();
        }
      } finally {
        sourceHandle.dispose();
      }
    },
    fromViewInfo: (tag, buffer, byteOffset, length) => {
      const Constructor = typedArrayConstructors.get(tag);
      if (!Constructor) throw new Error(`${tag} is not available in the VM`);
      if (byteOffset === undefined) {
        return vm.construct(Constructor, buffer as JSValueHandle);
      }
      const offsetHandle = vm.newNumber(byteOffset);
      const lengthHandle = vm.newNumber(length ?? 0);
      try {
        return vm.construct(
          Constructor,
          buffer as JSValueHandle,
          offsetHandle,
          lengthHandle
        );
      } finally {
        offsetHandle.dispose();
        lengthHandle.dispose();
      }
    },
    box: (value) => vm.construct(i.Object, value as JSValueHandle),
    createArray: (length) => {
      const lengthHandle = vm.newNumber(length);
      try {
        return vm.construct(i.Array, lengthHandle);
      } finally {
        lengthHandle.dispose();
      }
    },
    createSparseArray: (length) => {
      const lengthHandle = vm.newNumber(length);
      try {
        return invoke(i.makeSparseArray, lengthHandle);
      } finally {
        lengthHandle.dispose();
      }
    },
    createObject: () => vm.newObject(),
    createNullPrototypeObject: () =>
      call(i.objectCreate, vm.undefined, vm.null),
    createSet: () => vm.construct(i.Set),
    createMap: () => vm.construct(i.Map),
    set: (target, key, value) =>
      define(target as JSValueHandle, String(key), value as JSValueHandle),
    addValue: (set, value) => {
      call(i.setAdd, set as JSValueHandle, value as JSValueHandle).dispose();
    },
    addEntry: (map, key, value) => {
      call(
        i.mapSet,
        map as JSValueHandle,
        key as JSValueHandle,
        value as JSValueHandle
      ).dispose();
    },
  };

  // --- workflow revivers (handle space) ---

  /** Guest lookup of a registered error class on globalThis, by symbol. */
  const registeredErrorClass = (
    name: SymbolName
  ): JSValueHandle | undefined => {
    const cls = own(vm.global, sym(name));
    if (!cls || cls.typeof !== 'function') {
      cls?.dispose();
      return undefined;
    }
    return cls;
  };

  /** Construct a guest Error via `ctor(message)` + define stack/cause. */
  const buildError = (
    ctor: JSValueHandle,
    value: JSValueHandle,
    opts: { name?: string; extraCtorArgs?: JSValueHandle[] } = {}
  ): JSValueHandle => {
    const message = own(value, 'message') ?? vm.undefined;
    const error = vm.construct(ctor, message, ...(opts.extraCtorArgs ?? []));
    if (message !== vm.undefined) message.dispose();
    if (opts.name !== undefined) {
      const nameHandle = newGuestString(opts.name);
      define(error, 'name', nameHandle);
      nameHandle.dispose();
    }
    const stack = own(value, 'stack');
    if (stack && !stack.isUndefined) define(error, 'stack', stack);
    stack?.dispose();
    if (guestHasOwn(value, 'cause')) {
      const cause = own(value, 'cause') ?? vm.undefined;
      define(error, 'cause', cause);
      if (cause !== vm.undefined) cause.dispose();
    }
    return error;
  };

  const namedErrorSubclassReviver =
    (subclassName: string) => (value: JSValueHandle) => {
      const ctor = errorConstructors.get(subclassName);
      if (ctor) return buildError(ctor, value);
      return buildError(i.Error, value, { name: subclassName });
    };

  const reviveAbortSignal = (value: JSValueHandle): JSValueHandle => {
    const cls = own(vm.global, '__WorkflowAbortSignal');
    if (!cls || cls.typeof !== 'function') {
      cls?.dispose();
      throw new Error(
        'WorkflowAbortSignal is not registered in the VM (bootstrap not evaluated)'
      );
    }
    try {
      const streamName = own(value, 'streamName') ?? vm.undefined;
      const hookToken = own(value, 'hookToken') ?? vm.undefined;
      const signal = vm.construct(cls, streamName, hookToken);
      if (streamName !== vm.undefined) streamName.dispose();
      if (hookToken !== vm.undefined) hookToken.dispose();
      const aborted = own(value, 'aborted');
      if (aborted?.toBoolean()) {
        const setAborted = chained(signal, '_setAborted');
        if (setAborted) {
          const reason = own(value, 'reason') ?? vm.undefined;
          call(setAborted, signal, reason).dispose();
          if (reason !== vm.undefined) reason.dispose();
          setAborted.dispose();
        }
      }
      aborted?.dispose();
      return signal;
    } finally {
      cls.dispose();
    }
  };

  const revivers: Record<string, (value: any) => any> = {
    AbortController: (value: JSValueHandle) => {
      const controller = vm.newObject();
      const streamName = own(value, 'streamName') ?? vm.undefined;
      define(controller, sym('WORKFLOW_ABORT_STREAM_NAME'), streamName);
      if (streamName !== vm.undefined) streamName.dispose();
      const hookToken = own(value, 'hookToken') ?? vm.undefined;
      define(controller, sym('WORKFLOW_ABORT_HOOK_TOKEN'), hookToken);
      if (hookToken !== vm.undefined) hookToken.dispose();
      const signal = reviveAbortSignal(value);
      define(controller, 'signal', signal);
      signal.dispose();
      const noop = vm.evalCode('(function(){})');
      define(controller, 'abort', noop);
      noop.dispose();
      return controller;
    },
    AbortSignal: (value: JSValueHandle) => reviveAbortSignal(value),
    Class: (value: JSValueHandle) => {
      const classId = ownString(value, 'classId');
      const cls = lookupRegisteredClass(classId);
      if (!cls) {
        throw new Error(
          `Class "${classId}" not found. Make sure the class is registered with registerSerializationClass.`
        );
      }
      return cls;
    },
    Instance: (value: JSValueHandle) => {
      const classId = ownString(value, 'classId');
      const cls = lookupRegisteredClass(classId);
      if (!cls) {
        throw new Error(
          `Class "${classId}" not found. Make sure the class is registered with registerSerializationClass.`
        );
      }
      try {
        const deserializeMethod = chained(cls, sym('workflow-deserialize'));
        if (!deserializeMethod || deserializeMethod.typeof !== 'function') {
          deserializeMethod?.dispose();
          throw new Error(
            `Class "${classId}" does not have a static Symbol(workflow-deserialize) method.`
          );
        }
        try {
          const data = own(value, 'data') ?? vm.undefined;
          const result = call(deserializeMethod, cls, data);
          if (data !== vm.undefined) data.dispose();
          return result;
        } finally {
          deserializeMethod.dispose();
        }
      } finally {
        cls.dispose();
      }
    },
    StepFunction: (value: JSValueHandle) => {
      const useStep = own(vm.global, sym('WORKFLOW_USE_STEP'));
      if (!useStep || useStep.typeof !== 'function') {
        useStep?.dispose();
        throw new Error(
          'WORKFLOW_USE_STEP not found on global object. Step functions cannot be deserialized outside workflow context.'
        );
      }
      try {
        const stepId = own(value, 'stepId') ?? vm.undefined;
        const closureVars = own(value, 'closureVars');
        let proxy: JSValueHandle;
        if (closureVars && !closureVars.isUndefined) {
          const thunk = invoke(i.makeThunk, closureVars);
          proxy = invoke(useStep, stepId, thunk);
          thunk.dispose();
        } else {
          proxy = invoke(useStep, stepId);
        }
        closureVars?.dispose();
        if (stepId !== vm.undefined) stepId.dispose();
        if (guestHasOwn(value, 'boundThis')) {
          // Re-bind through the proxy's own (overridden) `.bind`, which is
          // an own data property stamped by WORKFLOW_USE_STEP.
          const bind = own(proxy, 'bind') ?? chained(proxy, 'bind');
          const boundThis = own(value, 'boundThis') ?? vm.undefined;
          const boundArgs = own(value, 'boundArgs');
          const args: JSValueHandle[] = [boundThis];
          const argHandles: JSValueHandle[] = [];
          if (boundArgs && boundArgs.isArray) {
            const length =
              own(boundArgs, 'length')?.consume((h) => h.toNumber()) ?? 0;
            for (let index = 0; index < length; index++) {
              const element = own(boundArgs, String(index)) ?? vm.undefined;
              args.push(element);
              if (element !== vm.undefined) argHandles.push(element);
            }
          }
          boundArgs?.dispose();
          if (bind) {
            const bound = call(bind, proxy, ...args);
            bind.dispose();
            proxy.dispose();
            proxy = bound;
          }
          if (boundThis !== vm.undefined) boundThis.dispose();
          for (const handle of argHandles) handle.dispose();
        }
        return proxy;
      } finally {
        useStep.dispose();
      }
    },
    ArrayBuffer: (value: string | JSValueHandle) =>
      vm.newArrayBuffer(
        base64ToBytes(isHandle(value) ? value.toString() : value)
          .buffer as ArrayBuffer
      ),
    BigInt: (value: string | JSValueHandle) =>
      vm.newBigInt(BigInt(isHandle(value) ? value.toString() : value)),
    BigInt64Array: (value: string | JSValueHandle) =>
      buildTypedArray('BigInt64Array', value),
    BigUint64Array: (value: string | JSValueHandle) =>
      buildTypedArray('BigUint64Array', value),
    Date: (value: JSValueHandle | string) => {
      // The reducer emits '.' for invalid dates and an ISO string otherwise.
      const iso = isHandle(value) ? value.toString() : value;
      const argument =
        iso === '.' ? vm.newNumber(Number.NaN) : vm.newString(iso);
      try {
        return vm.construct(i.Date, argument);
      } finally {
        argument.dispose();
        if (isHandle(value)) value.dispose();
      }
    },
    DOMException: (value: JSValueHandle) => {
      if (i.DOMException) {
        const message = own(value, 'message') ?? vm.undefined;
        const name = own(value, 'name') ?? vm.undefined;
        const error = vm.construct(i.DOMException, message, name);
        if (message !== vm.undefined) message.dispose();
        if (name !== vm.undefined) name.dispose();
        const stack = own(value, 'stack');
        if (stack && !stack.isUndefined) define(error, 'stack', stack);
        stack?.dispose();
        if (guestHasOwn(value, 'cause')) {
          const cause = own(value, 'cause') ?? vm.undefined;
          define(error, 'cause', cause);
          if (cause !== vm.undefined) cause.dispose();
        }
        return error;
      }
      return buildError(i.Error, value, {
        name: ownString(value, 'name') ?? 'DOMException',
      });
    },
    AggregateError: (value: JSValueHandle) => {
      const errors = own(value, 'errors');
      const errorsArg =
        errors && !errors.isUndefined ? errors : vm.evalCode('([])');
      const message = own(value, 'message') ?? vm.undefined;
      const ctor = i.AggregateError ?? i.Error;
      const error =
        ctor === i.AggregateError
          ? vm.construct(ctor, errorsArg, message)
          : buildError(i.Error, value, { name: 'AggregateError' });
      if (ctor === i.AggregateError) {
        const stack = own(value, 'stack');
        if (stack && !stack.isUndefined) define(error, 'stack', stack);
        stack?.dispose();
        if (guestHasOwn(value, 'cause')) {
          const cause = own(value, 'cause') ?? vm.undefined;
          define(error, 'cause', cause);
          if (cause !== vm.undefined) cause.dispose();
        }
      }
      if (message !== vm.undefined) message.dispose();
      errorsArg.dispose();
      return error;
    },
    EvalError: namedErrorSubclassReviver('EvalError'),
    FatalError: (value: JSValueHandle) => {
      const cls = registeredErrorClass('@workflow/errors//FatalError');
      const error = cls
        ? buildError(cls, value)
        : buildError(i.Error, value, { name: 'FatalError' });
      cls?.dispose();
      return error;
    },
    HookConflictError: (value: JSValueHandle) => {
      const cls = registeredErrorClass('@workflow/errors//HookConflictError');
      let error: JSValueHandle;
      if (cls) {
        // Constructor takes (token, conflictingRunId).
        const token = own(value, 'token') ?? vm.undefined;
        const conflictingRunId = own(value, 'conflictingRunId') ?? vm.undefined;
        error = vm.construct(cls, token, conflictingRunId);
        if (token !== vm.undefined) token.dispose();
        if (conflictingRunId !== vm.undefined) conflictingRunId.dispose();
        const stack = own(value, 'stack');
        if (stack && !stack.isUndefined) define(error, 'stack', stack);
        stack?.dispose();
        if (guestHasOwn(value, 'cause')) {
          const cause = own(value, 'cause') ?? vm.undefined;
          define(error, 'cause', cause);
          if (cause !== vm.undefined) cause.dispose();
        }
        cls.dispose();
      } else {
        error = buildError(i.Error, value, { name: 'HookConflictError' });
        const token = own(value, 'token');
        if (token) {
          define(error, 'token', token);
          token.dispose();
        }
        const conflictingRunId = own(value, 'conflictingRunId');
        if (conflictingRunId && !conflictingRunId.isUndefined) {
          define(error, 'conflictingRunId', conflictingRunId);
        }
        conflictingRunId?.dispose();
      }
      return error;
    },
    RangeError: namedErrorSubclassReviver('RangeError'),
    ReferenceError: namedErrorSubclassReviver('ReferenceError'),
    RetryableError: (value: JSValueHandle) => {
      const retryAfterMs =
        own(value, 'retryAfter')?.consume((h) =>
          h.isNumber ? h.toNumber() : Number.NaN
        ) ?? Number.NaN;
      const timeHandle = vm.newNumber(retryAfterMs);
      const retryAfterDate = vm.construct(i.Date, timeHandle);
      timeHandle.dispose();
      const cls = registeredErrorClass('@workflow/errors//RetryableError');
      let error: JSValueHandle;
      if (cls) {
        // Constructor takes (message, { retryAfter }).
        const options = vm.newObject();
        options.setProp('retryAfter', retryAfterDate);
        const message = own(value, 'message') ?? vm.undefined;
        error = vm.construct(cls, message, options);
        if (message !== vm.undefined) message.dispose();
        options.dispose();
        const stack = own(value, 'stack');
        if (stack && !stack.isUndefined) define(error, 'stack', stack);
        stack?.dispose();
        if (guestHasOwn(value, 'cause')) {
          const cause = own(value, 'cause') ?? vm.undefined;
          define(error, 'cause', cause);
          if (cause !== vm.undefined) cause.dispose();
        }
        cls.dispose();
      } else {
        error = buildError(i.Error, value, { name: 'RetryableError' });
        define(error, 'retryAfter', retryAfterDate);
      }
      retryAfterDate.dispose();
      return error;
    },
    RuntimeDecryptionError: (value: JSValueHandle) => {
      const cls = registeredErrorClass(
        '@workflow/errors//RuntimeDecryptionError'
      );
      let error: JSValueHandle;
      if (cls) {
        // Constructor takes (message, { cause, context }).
        const options = vm.newObject();
        const context = own(value, 'context');
        if (context && !context.isUndefined) {
          options.setProp('context', context);
        }
        context?.dispose();
        if (guestHasOwn(value, 'cause')) {
          const cause = own(value, 'cause') ?? vm.undefined;
          options.setProp('cause', cause);
          if (cause !== vm.undefined) cause.dispose();
        }
        const message = own(value, 'message') ?? vm.undefined;
        error = vm.construct(cls, message, options);
        if (message !== vm.undefined) message.dispose();
        options.dispose();
        const stack = own(value, 'stack');
        if (stack && !stack.isUndefined) define(error, 'stack', stack);
        stack?.dispose();
        cls.dispose();
      } else {
        error = buildError(i.Error, value, { name: 'RuntimeDecryptionError' });
        const context = own(value, 'context');
        if (context && !context.isUndefined) {
          define(error, 'context', context);
        }
        context?.dispose();
      }
      return error;
    },
    SyntaxError: namedErrorSubclassReviver('SyntaxError'),
    TypeError: namedErrorSubclassReviver('TypeError'),
    URIError: namedErrorSubclassReviver('URIError'),
    Error: (value: JSValueHandle) =>
      buildError(i.Error, value, {
        name: ownString(value, 'name') ?? 'Error',
      }),
    Float32Array: (value: string | JSValueHandle) =>
      buildTypedArray('Float32Array', value),
    Float64Array: (value: string | JSValueHandle) =>
      buildTypedArray('Float64Array', value),
    Int8Array: (value: string | JSValueHandle) =>
      buildTypedArray('Int8Array', value),
    Int16Array: (value: string | JSValueHandle) =>
      buildTypedArray('Int16Array', value),
    Int32Array: (value: string | JSValueHandle) =>
      buildTypedArray('Int32Array', value),
    Map: (value: JSValueHandle) => {
      // value is a guest array of [k, v] arrays.
      const map = vm.construct(i.Map);
      const length = own(value, 'length')?.consume((h) => h.toNumber()) ?? 0;
      for (let index = 0; index < length; index++) {
        const entry = own(value, String(index));
        if (!entry) continue;
        const key = own(entry, '0') ?? vm.undefined;
        const entryValue = own(entry, '1') ?? vm.undefined;
        call(i.mapSet, map, key, entryValue).dispose();
        if (key !== vm.undefined) key.dispose();
        if (entryValue !== vm.undefined) entryValue.dispose();
        entry.dispose();
      }
      return map;
    },
    RegExp: (value: JSValueHandle) => {
      const source = own(value, 'source') ?? vm.undefined;
      const flags = own(value, 'flags') ?? vm.undefined;
      const regexp = vm.construct(i.RegExp, source, flags);
      if (source !== vm.undefined) source.dispose();
      if (flags !== vm.undefined) flags.dispose();
      return regexp;
    },
    Set: (value: JSValueHandle) => {
      const set = vm.construct(i.Set);
      const length = own(value, 'length')?.consume((h) => h.toNumber()) ?? 0;
      for (let index = 0; index < length; index++) {
        const element = own(value, String(index)) ?? vm.undefined;
        call(i.setAdd, set, element).dispose();
        if (element !== vm.undefined) element.dispose();
      }
      return set;
    },
    URL: (value: JSValueHandle | string) => {
      if (!i.URL) throw new Error('URL is not available in the VM');
      const href = isHandle(value) ? value : vm.newString(value);
      try {
        return vm.construct(i.URL, href);
      } finally {
        if (!isHandle(value)) href.dispose();
      }
    },
    WorkflowFunction: (value: JSValueHandle) => {
      const workflowId = own(value, 'workflowId') ?? vm.undefined;
      const throwerFactory = vm.evalCode(
        `(function(workflowId) {
          var f = function() {
            throw new Error('Workflow functions cannot be called directly. Use start() to invoke them.');
          };
          f.workflowId = workflowId;
          return f;
        })`
      );
      try {
        return invoke(throwerFactory, workflowId);
      } finally {
        throwerFactory.dispose();
        if (workflowId !== vm.undefined) workflowId.dispose();
      }
    },
    URLSearchParams: (value: JSValueHandle | string) => {
      if (!i.URLSearchParams) {
        throw new Error('URLSearchParams is not available in the VM');
      }
      const raw = isHandle(value) ? value.toString() : value;
      const init = vm.newString(raw === '.' ? '' : raw);
      try {
        return vm.construct(i.URLSearchParams, init);
      } finally {
        init.dispose();
        if (isHandle(value)) value.dispose();
      }
    },
    Uint8Array: (value: string | JSValueHandle) =>
      buildTypedArray('Uint8Array', value),
    Uint8ClampedArray: (value: string | JSValueHandle) =>
      buildTypedArray('Uint8ClampedArray', value),
    Uint16Array: (value: string | JSValueHandle) =>
      buildTypedArray('Uint16Array', value),
    Uint32Array: (value: string | JSValueHandle) =>
      buildTypedArray('Uint32Array', value),
    Headers: (value: JSValueHandle) => {
      if (!i.Headers) throw new Error('Headers is not available in the VM');
      return vm.construct(i.Headers, value);
    },
    Request: (value: JSValueHandle) => {
      // Mirror the in-VM reviver: mutate the parsed object into a
      // Request-alike by attaching the prototype methods directly.
      if (i.requestPrototype) {
        for (const method of ['json', 'text', 'arrayBuffer']) {
          const fn = own(i.requestPrototype, method);
          if (fn && fn.typeof === 'function') define(value, method, fn);
          fn?.dispose();
        }
      }
      const responseWritable = own(value, 'responseWritable');
      if (responseWritable && !responseWritable.isUndefined) {
        define(value, sym('WEBHOOK_RESPONSE_WRITABLE'), responseWritable);
      }
      responseWritable?.dispose();
      return value.dup();
    },
    Response: (value: JSValueHandle) => {
      if (i.responsePrototype) {
        for (const method of [
          'json',
          'text',
          'arrayBuffer',
          'bytes',
          'clone',
        ]) {
          const fn = own(i.responsePrototype, method);
          if (fn && fn.typeof === 'function') define(value, method, fn);
          fn?.dispose();
        }
      }
      const body = own(value, 'body') ?? vm.undefined;
      define(value, '_body', body);
      if (body !== vm.undefined) body.dispose();
      const status = own(value, 'status')?.consume((h) => h.toNumber()) ?? 0;
      const ok = status >= 200 && status < 300 ? vm.true : vm.false;
      define(value, 'ok', ok);
      define(value, 'bodyUsed', vm.false);
      return value.dup();
    },
    ReadableStream: (value: JSValueHandle) => {
      const prototype = i.readableStreamPrototype ?? vm.null;
      const stream = call(i.objectCreate, vm.undefined, prototype);
      const bodyInit = own(value, 'bodyInit');
      if (bodyInit && !bodyInit.isUndefined) {
        define(stream, sym('BODY_INIT'), bodyInit);
        bodyInit.dispose();
        return stream;
      }
      bodyInit?.dispose();
      const name = own(value, 'name');
      if (name && !name.isUndefined) {
        define(stream, sym('WORKFLOW_STREAM_NAME'), name);
        const type = own(value, 'type');
        if (type && !type.isUndefined) {
          define(stream, sym('WORKFLOW_STREAM_TYPE'), type);
        }
        type?.dispose();
        const framing = own(value, 'framing');
        if (framing && !framing.isUndefined) {
          define(stream, sym('WORKFLOW_STREAM_FRAMING'), framing);
        }
        framing?.dispose();
      }
      name?.dispose();
      return stream;
    },
    WritableStream: (value: JSValueHandle) => {
      const prototype = i.writableStreamPrototype ?? vm.null;
      const stream = call(i.objectCreate, vm.undefined, prototype);
      const name = own(value, 'name');
      if (name && !name.isUndefined) {
        define(stream, sym('WORKFLOW_STREAM_NAME'), name);
      }
      name?.dispose();
      const runId = own(value, 'runId');
      if (runId?.isString) {
        define(stream, sym('WORKFLOW_STREAM_SERVER_RUN_ID'), runId);
      }
      runId?.dispose();
      const deploymentId = own(value, 'deploymentId');
      if (deploymentId?.isString) {
        define(
          stream,
          sym('WORKFLOW_STREAM_SERVER_DEPLOYMENT_ID'),
          deploymentId
        );
      }
      deploymentId?.dispose();
      return stream;
    },
  };

  function buildTypedArray(
    tag: string,
    base64: string | JSValueHandle
  ): JSValueHandle {
    const Constructor = typedArrayConstructors.get(tag);
    if (!Constructor) throw new Error(`${tag} is not available in the VM`);
    // Parse operations build guest values, so a reduced base64 payload
    // arrives as a guest string handle.
    const raw = isHandle(base64) ? base64.toString() : base64;
    const bytes = base64ToBytes(raw);
    const buffer = vm.newArrayBuffer(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer
    );
    try {
      return vm.construct(Constructor, buffer);
    } finally {
      buffer.dispose();
    }
  }

  function lookupRegisteredClass(
    classId: string | undefined
  ): JSValueHandle | undefined {
    if (classId === undefined) return undefined;
    const registry = own(vm.global, sym('workflow-class-registry'));
    if (!registry || registry.isUndefined) {
      registry?.dispose();
      return undefined;
    }
    try {
      const getMethod = chained(registry, 'get');
      if (!getMethod) return undefined;
      try {
        const key = vm.newString(classId);
        const cls = call(getMethod, registry, key);
        key.dispose();
        if (cls.isUndefined || cls.typeof !== 'function') {
          cls.dispose();
          return undefined;
        }
        return cls;
      } finally {
        getMethod.dispose();
      }
    } finally {
      registry.dispose();
    }
  }

  // --- public API ---

  return {
    reducerKeys: Object.keys(reducers),
    reviverKeys: Object.keys(revivers),
    serialize(value: JSValueHandle): Uint8Array {
      // Handle scope: reducers and the hybrid operations mint one handle
      // per visited value node (descriptor reads, dup()s, intrinsic call
      // results) and nothing disposes them individually — without the
      // scope each serialize leaks ~one handle per node for the VM's
      // lifetime, which compounds across an inline-loop session's whole
      // batch. Requires quickjs-wasi >= 3.3.1: earlier versions also
      // scope-tracked the handles the host-callback trampoline wraps
      // around C-owned argv pointers, and disposing those (Map/Set/
      // Headers forEach visitors run mid-pass) corrupted the guest heap;
      // 3.3.1 marks them borrowed and scope-exempt. The input handle is
      // caller-owned (created before the scope) and the output is host
      // bytes, so nothing escapes.
      //
      // `identities` must be cleared per pass ONCE handles are bulk-freed:
      // it keys object identity on the raw guest pointer, and freeing
      // handles lets QuickJS reuse pointers — a stale entry from an
      // earlier pass could then alias a different object and corrupt the
      // dedup/cycle detection. Identity only needs stability within one
      // stringify pass.
      try {
        const payload = vm.withScope(() =>
          encoder.encode(
            stringify(value, reducers, { operations: stringifyOperations })
          )
        );
        const prefix = encoder.encode(SerializationFormat.DEVALUE_V1);
        const result = new Uint8Array(prefix.length + payload.length);
        result.set(prefix, 0);
        result.set(payload, prefix.length);
        return result;
      } finally {
        identities.clear();
      }
    },
    deserialize(data: Uint8Array): JSValueHandle {
      if (data.length < FORMAT_PREFIX_LENGTH) {
        throw new Error('Data too short to contain format prefix');
      }
      const prefix = decoder.decode(data.subarray(0, FORMAT_PREFIX_LENGTH));
      if (prefix !== SerializationFormat.DEVALUE_V1) {
        throw new Error(`Unsupported serialization format: ${prefix}`);
      }
      const payload = decoder.decode(data.subarray(FORMAT_PREFIX_LENGTH));
      // Handle scope, mirroring serialize(): revivers mint intermediate
      // handles (children already attached to their parents, intrinsic
      // call results) that are safe to free once the graph is built —
      // guest values are refcounted, so parents keep their children
      // alive. Only the root escapes to the caller.
      return vm.withScope((scope) =>
        scope.escape(
          parse(payload, revivers, {
            operations: parseOperations,
          }) as JSValueHandle
        )
      );
    },
    dispose() {
      for (const handle of disposables.reverse()) handle.dispose();
      disposables.length = 0;
      identities.clear();
    },
  };
}
