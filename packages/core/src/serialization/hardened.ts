/**
 * Hardened introspection for serializing values that may originate inside a
 * workflow VM (`node:vm`) sandbox realm.
 *
 * Serialization runs on the host, but the values it inspects were
 * constructed by workflow code — so a naive dynamic operation like
 * `value.toISOString()`, `Array.from(map)`, or `Object.prototype.toString`
 * dispatches into the sandbox realm and executes workflow code (patched
 * prototype methods, getters, proxy traps, `Symbol.toStringTag` accessors).
 * That is a determinism hazard: serialization happens exactly once per
 * payload (never again on replay), so any workflow-visible side effect it
 * triggers exists only on the live execution path and diverges from replay.
 *
 * This module makes serialization side-effect free wherever the data allows
 * it, and *observable* where it does not:
 *
 * - **Classification** uses engine-level brand checks (`node:util` `types`,
 *   internal-slot probes) instead of `instanceof` / `Object.prototype.toString`
 *   — immune to `Symbol.hasInstance`, `Symbol.toStringTag`, and reassigned
 *   globals.
 * - **Extraction** goes through intrinsics captured at module load (host
 *   boot, before any workflow code runs), invoked with an explicit receiver.
 *   Internal slots are realm-agnostic, so host intrinsics operate on
 *   VM-realm objects without touching the sandbox's (patchable) prototypes.
 * - **Property access** reads through descriptors, so plain data never
 *   invokes anything. Where workflow code *must* run because the data itself
 *   lives behind it — getters, proxies, custom `[WORKFLOW_SERIALIZE]`
 *   methods, `toString()` on toStringTag-branded objects (e.g. Temporal
 *   polyfills) — the execution is preserved for compatibility and recorded
 *   in the active {@link GuestCodeStats} sink, so callers (e.g. a retained-VM
 *   gate) can react.
 *
 * The recorder is ambient module state, set for the duration of a
 * synchronous `stringify` call via {@link withGuestCodeStats}. devalue's
 * `stringify` is fully synchronous, so this is safe without async context.
 */

import { types } from 'node:util';
import type { StringifyOperations } from 'devalue';
import { defaultStringifyOperations } from 'devalue';

// ---- Guest code observation -------------------------------------------------

/**
 * A single instance of workflow (guest) code executing during serialization.
 */
export interface GuestCodeExecution {
  /**
   * What forced the execution:
   * - `getter`: an accessor property was invoked to read data
   * - `proxy`: a proxy was introspected, firing its traps
   * - `method`: a workflow-defined function was invoked (e.g. a custom
   *   `[WORKFLOW_SERIALIZE]` serializer, `toString()` on a
   *   `Symbol.toStringTag`-branded object, a duck-typed `getTime()`)
   */
  kind: 'getter' | 'proxy' | 'method';
  /** Best-effort context: the property key, method name, or tag involved. */
  detail?: string;
}

/**
 * Mutable sink recording every workflow-code execution serialization could
 * not avoid. Pass via `CodecOptions.guestCodeStats`; consumers that retain
 * the VM across steps can use a non-empty `executions` array as a signal
 * that the VM state may have been perturbed by serialization.
 */
export interface GuestCodeStats {
  executions: GuestCodeExecution[];
}

let activeStats: GuestCodeStats | null = null;
let reportedProxies: WeakSet<object> | null = null;

/**
 * Runs `fn` (synchronously) with `stats` as the active guest-code sink.
 * Nested calls stack correctly; a `null`/`undefined` sink disables
 * recording without disabling hardening.
 */
export function withGuestCodeStats<T>(
  stats: GuestCodeStats | undefined,
  fn: () => T
): T {
  const previousStats = activeStats;
  const previousProxies = reportedProxies;
  activeStats = stats ?? null;
  reportedProxies = stats ? new WeakSet() : null;
  try {
    return fn();
  } finally {
    activeStats = previousStats;
    reportedProxies = previousProxies;
  }
}

export function recordGuestCode(
  kind: GuestCodeExecution['kind'],
  detail?: string
): void {
  if (!activeStats) return;
  const execution: GuestCodeExecution = { kind };
  if (detail !== undefined) execution.detail = detail;
  activeStats.executions.push(execution);
}

/** Records a proxy once per serialization pass (proxies fire many traps). */
function recordProxy(value: object): void {
  if (!activeStats || !reportedProxies) return;
  if (reportedProxies.has(value)) return;
  reportedProxies.add(value);
  recordGuestCode('proxy');
}

// ---- Captured intrinsics ----------------------------------------------------
//
// Captured at module load — host boot, before any workflow bundle can run.
// Invoked with explicit receivers so no property lookup ever resolves
// through a sandbox-realm prototype chain.

const uncurryThis = Function.prototype.bind.bind(Function.prototype.call) as <
  T,
  A extends unknown[],
  R,
>(
  fn: (this: T, ...args: A) => R
) => (thisArg: T, ...args: A) => R;

function intrinsicGetter(prototype: object, key: PropertyKey) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (!descriptor?.get) {
    throw new Error(`Missing intrinsic getter ${String(key)}`);
  }
  return uncurryThis(descriptor.get as (this: unknown) => unknown);
}

const TypedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype
) as object;

const call = {
  dateGetDate: uncurryThis(Date.prototype.getDate),
  dateGetTime: uncurryThis(Date.prototype.getTime),
  dateToISOString: uncurryThis(Date.prototype.toISOString),
  mapEntries: uncurryThis(Map.prototype.entries),
  setValues: uncurryThis(Set.prototype.values),
  headersIterator: uncurryThis(
    Headers.prototype[Symbol.iterator] as (this: Headers) => Iterator<unknown>
  ),
  urlSearchParamsToString: uncurryThis(URLSearchParams.prototype.toString),
  numberValueOf: uncurryThis(Number.prototype.valueOf),
  stringValueOf: uncurryThis(String.prototype.valueOf),
  booleanValueOf: uncurryThis(Boolean.prototype.valueOf),
  bigIntValueOf: uncurryThis(
    BigInt.prototype.valueOf as (this: unknown) => bigint
  ),
};

const get = {
  regExpSource: intrinsicGetter(RegExp.prototype, 'source'),
  regExpFlags: intrinsicGetter(RegExp.prototype, 'flags'),
  typedArrayTag: intrinsicGetter(TypedArrayPrototype, Symbol.toStringTag) as (
    value: unknown
  ) => string | undefined,
  typedArrayBuffer: intrinsicGetter(TypedArrayPrototype, 'buffer'),
  typedArrayByteOffset: intrinsicGetter(TypedArrayPrototype, 'byteOffset'),
  typedArrayByteLength: intrinsicGetter(TypedArrayPrototype, 'byteLength'),
  typedArrayLength: intrinsicGetter(TypedArrayPrototype, 'length'),
  dataViewBuffer: intrinsicGetter(DataView.prototype, 'buffer'),
  dataViewByteOffset: intrinsicGetter(DataView.prototype, 'byteOffset'),
  dataViewByteLength: intrinsicGetter(DataView.prototype, 'byteLength'),
  arrayBufferByteLength: intrinsicGetter(ArrayBuffer.prototype, 'byteLength'),
  sharedArrayBufferByteLength:
    typeof SharedArrayBuffer === 'function'
      ? intrinsicGetter(SharedArrayBuffer.prototype, 'byteLength')
      : undefined,
  urlHref: intrinsicGetter(URL.prototype, 'href'),
  urlSearchParamsSize: intrinsicGetter(URLSearchParams.prototype, 'size'),
};

// ---- Safe access primitives -------------------------------------------------

const { isProxy } = types;

const functionToString = uncurryThis(Function.prototype.toString);

/** Memoized nativeness, keyed on the getter function itself. */
const engineAccessorCache = new WeakMap<object, boolean>();

/**
 * Whether an accessor is engine-provided rather than workflow-defined.
 *
 * Some accessors that serialization must read are installed by the engine,
 * not by workflow code — most importantly `stack`, which V8 defines as an
 * *own accessor* on every Error instance. Invoking those cannot execute
 * workflow code, so reporting them would drown the signal in noise (every
 * serialized error would report a guest-code execution).
 *
 * Nativeness is decided with the captured host `Function.prototype.toString`,
 * which works cross-realm and cannot be intercepted by the sandbox.
 *
 * Known limitation: a bound function (`fn.bind(x)`) also reports as native
 * code, so a workflow that installs `{ get: sideEffect.bind(null) }` on a
 * serialized value would not be reported. The consequence is a missing
 * telemetry entry — never incorrect output — and the construction is exotic
 * enough that the alternative (reporting every `error.stack` read) is far
 * worse. Note also that V8's native `stack` getter can itself call a
 * workflow-defined `Error.prepareStackTrace` hook; that indirection is not
 * detected here.
 */
function isEngineAccessor(getter: object): boolean {
  const cached = engineAccessorCache.get(getter);
  if (cached !== undefined) return cached;
  let native = false;
  try {
    native = functionToString(getter as () => unknown).endsWith(
      '{ [native code] }'
    );
  } catch {
    // Not a plain function (e.g. a Proxy around one) — treat as workflow code.
    native = false;
  }
  engineAccessorCache.set(getter, native);
  return native;
}

/**
 * Reads `value[key]` with `[[Get]]` semantics, but through descriptors:
 * plain data properties never invoke anything; accessor properties are
 * invoked (the data lives behind them) and recorded; proxies fall back to
 * a plain read (their traps are the only access path) and are recorded.
 */
export function readProperty(value: unknown, key: PropertyKey): unknown {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return undefined;
  }
  if (isProxy(value)) {
    recordProxy(value);
    return (value as Record<PropertyKey, unknown>)[key];
  }

  let current: object | null = value;
  while (current !== null) {
    if (isProxy(current)) {
      // a proxy in the prototype chain — its traps answer the lookup
      recordProxy(current);
      return (value as Record<PropertyKey, unknown>)[key];
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if ('value' in descriptor) return descriptor.value;
      if (descriptor.get) {
        if (!isEngineAccessor(descriptor.get)) {
          recordGuestCode('getter', String(key));
        }
        return descriptor.get.call(value);
      }
      return undefined; // setter-only property
    }
    current = Reflect.getPrototypeOf(current);
  }
  return undefined;
}

/**
 * `key in value` semantics without firing proxy traps for ordinary
 * objects. Proxies fall back to the `in` operator and are recorded.
 */
export function hasProperty(value: unknown, key: PropertyKey): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }
  if (isProxy(value)) {
    recordProxy(value);
    return key in (value as object);
  }

  let current: object | null = value;
  while (current !== null) {
    if (isProxy(current)) {
      recordProxy(current);
      return key in (value as object);
    }
    if (Object.getOwnPropertyDescriptor(current, key)) return true;
    current = Reflect.getPrototypeOf(current);
  }
  return false;
}

/**
 * `value instanceof C` semantics for a known `C.prototype`, without
 * consulting `Symbol.hasInstance` (which workflow code can define). Used
 * for host classes that are injected into the sandbox (Headers, URL,
 * URLSearchParams, DOMException), where the instances — from any realm the
 * host handed the class to — carry the host prototype in their chain.
 *
 * Proxies return false without firing traps (and are recorded): a proxy
 * is not an instance of anything for serialization purposes.
 */
export function isInstanceOfPrototype(
  value: unknown,
  prototype: object
): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (isProxy(value)) {
    recordProxy(value);
    return false;
  }
  let current: object | null = Reflect.getPrototypeOf(value);
  while (current !== null) {
    if (current === prototype) return true;
    if (isProxy(current)) {
      recordProxy(current);
      return false;
    }
    current = Reflect.getPrototypeOf(current);
  }
  return false;
}

// ---- Intrinsic-backed extraction helpers (used by the reducers) -------------

/** `Date.prototype.getDate`, for invalid-date checks. */
export const dateGetDate = call.dateGetDate;
/** `Date.prototype.getTime`. */
export const dateGetTime = call.dateGetTime;
/** `Date.prototype.toISOString`. */
export const dateToISOString = call.dateToISOString;
/** `RegExp.prototype.source` getter. */
export const regExpSource = get.regExpSource as (value: unknown) => string;
/** `RegExp.prototype.flags` getter. */
export const regExpFlags = get.regExpFlags as (value: unknown) => string;
/** `URL.prototype.href` getter. */
export const urlHref = get.urlHref as (value: unknown) => string;
/** `URLSearchParams.prototype.size` getter. */
export const urlSearchParamsSize = get.urlSearchParamsSize as (
  value: unknown
) => number;
/** `URLSearchParams.prototype.toString`. */
export const urlSearchParamsToString = call.urlSearchParamsToString as (
  value: unknown
) => string;

/**
 * Iterates a genuine Map's entries entirely through host intrinsics: the
 * iterator object is created by the host `Map.prototype.entries`, so its
 * realm — and therefore its `next` — is the host's, not the sandbox's.
 */
export function mapToEntries(
  value: Map<unknown, unknown>
): [unknown, unknown][] {
  return [...call.mapEntries(value)];
}

/** See {@link mapToEntries}. */
export function setToValues(value: Set<unknown>): unknown[] {
  return [...call.setValues(value)];
}

/**
 * Iterates a Headers instance through the captured host iterator. Headers
 * is a host class injected into the sandbox, so instances are host-realm —
 * but the shared prototype is reachable from workflow code, which makes the
 * boot-time capture (rather than a live lookup) load-bearing.
 */
export function headersToEntries(value: Headers): [string, string][] {
  const iterator = call.headersIterator(value) as IterableIterator<
    [string, string]
  >;
  return [...iterator];
}

/**
 * The bytes of an `ArrayBufferView`, read via internal-slot getters —
 * own-property shadowing and prototype patches cannot change which bytes
 * are serialized.
 */
export function viewInfo(value: ArrayBufferView): {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
} {
  const isDataView = types.isDataView(value);
  return {
    buffer: (isDataView ? get.dataViewBuffer : get.typedArrayBuffer)(
      value
    ) as ArrayBufferLike,
    byteOffset: (isDataView
      ? get.dataViewByteOffset
      : get.typedArrayByteOffset)(value) as number,
    byteLength: (isDataView
      ? get.dataViewByteLength
      : get.typedArrayByteLength)(value) as number,
  };
}

/** `ArrayBuffer.prototype.byteLength` getter (internal slot read). */
export function arrayBufferByteLength(value: ArrayBuffer): number {
  return get.arrayBufferByteLength(value) as number;
}

// ---- Hardened devalue operations ---------------------------------------------
//
// The workflow reducers claim most special types before devalue's built-in
// handling runs, so these operations mainly govern plain objects, arrays,
// boxed primitives, thenable probes — and classification (`tagOf`), which
// runs for every object the reducers did not claim.

const KNOWN_VIEW_TAGS = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Float16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

/**
 * Tags that {@link brandOf} decides authoritatively. If the brand check said
 * "not one of these" then a `Symbol.toStringTag` claiming one is a spoof, and
 * honouring it would route the value into an extractor that requires the real
 * internal slot (`Object.prototype.toString` semantics let any object claim
 * `[object Date]`). Unbranded values that claim one of these are classified
 * as plain objects instead.
 */
const BRAND_DECIDED_TAGS = new Set([
  'Date',
  'RegExp',
  'Map',
  'Set',
  'Array',
  'DataView',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'Number',
  'String',
  'Boolean',
  'BigInt',
  'URL',
  'URLSearchParams',
  ...KNOWN_VIEW_TAGS,
]);

/**
 * Classifies a value by engine brand. Returns undefined when no brand
 * matches (the caller falls back to `Symbol.toStringTag` semantics).
 */
function brandOf(value: object): string | undefined {
  if (types.isDate(value)) return 'Date';
  if (types.isRegExp(value)) return 'RegExp';
  if (types.isMap(value)) return 'Map';
  if (types.isSet(value)) return 'Set';
  if (Array.isArray(value)) return 'Array';
  if (types.isTypedArray(value)) {
    const tag = get.typedArrayTag(value);
    return tag !== undefined && KNOWN_VIEW_TAGS.has(tag) ? tag : undefined;
  }
  if (types.isDataView(value)) return 'DataView';
  if (types.isArrayBuffer(value)) return 'ArrayBuffer';
  if (types.isSharedArrayBuffer(value)) return 'SharedArrayBuffer';
  if (types.isNumberObject(value)) return 'Number';
  if (types.isStringObject(value)) return 'String';
  if (types.isBooleanObject(value)) return 'Boolean';
  if (types.isBigIntObject(value)) return 'BigInt';
  if (isInstanceOfPrototype(value, URL.prototype)) return 'URL';
  if (isInstanceOfPrototype(value, URLSearchParams.prototype)) {
    return 'URLSearchParams';
  }
  return undefined;
}

/**
 * Reads `Symbol.toStringTag` the way `Object.prototype.toString` would,
 * but through descriptors — a data-property tag (the common case, e.g.
 * Temporal polyfills) costs no workflow-code execution; an accessor tag is
 * invoked (compat) and recorded.
 */
function readToStringTag(value: object): string | undefined {
  const tag = readProperty(value, Symbol.toStringTag);
  return typeof tag === 'string' ? tag : undefined;
}

export const hardenedStringifyOperations: Partial<StringifyOperations> = {
  tagOf: (value: object) => {
    if (isProxy(value)) {
      // A proxy's classification is answered by its traps — that is the
      // only access path there is. Record it and preserve today's
      // behavior for everything downstream.
      recordProxy(value);
      return defaultStringifyOperations.tagOf(value);
    }
    const brand = brandOf(value);
    if (brand !== undefined) return brand;
    // No engine brand matched. A `Symbol.toStringTag` is still meaningful for
    // types devalue identifies that way (`Temporal.*`), but one naming a
    // brand-decided type is a spoof and is ignored.
    const tag = readToStringTag(value);
    if (tag === undefined || BRAND_DECIDED_TAGS.has(tag)) return 'Object';
    return tag;
  },

  isThenable: (value: { then?: unknown }) => {
    if (types.isPromise(value)) return true;
    return typeof readProperty(value, 'then') === 'function';
  },

  unbox: (boxed: object) => {
    if (types.isNumberObject(boxed)) return call.numberValueOf(boxed);
    if (types.isStringObject(boxed)) return call.stringValueOf(boxed);
    if (types.isBooleanObject(boxed)) return call.booleanValueOf(boxed);
    return call.bigIntValueOf(boxed);
  },

  toISOString: (date: Date) =>
    Number.isNaN(call.dateGetDate(date)) ? '' : call.dateToISOString(date),

  toStringValue: (value: object) => {
    // Reached for URL / URLSearchParams (when the reducers did not claim
    // them, e.g. instances of a different realm's classes) and for
    // toStringTag-branded objects like Temporal polyfills, whose string
    // form only their own toString() can produce.
    if (isInstanceOfPrototype(value, URL.prototype)) {
      return urlHref(value);
    }
    if (isInstanceOfPrototype(value, URLSearchParams.prototype)) {
      return urlSearchParamsToString(value);
    }
    recordGuestCode(
      'method',
      `toString (${readToStringTag(value) ?? 'unknown'})`
    );
    return (value as { toString(): string }).toString();
  },

  regExpInfo: (regexp: RegExp) => ({
    source: regExpSource(regexp),
    flags: regExpFlags(regexp),
  }),

  valuesOf: (set: Set<unknown>) => setToValues(set),
  entriesOf: (map: Map<unknown, unknown>) =>
    mapToEntries(map) as [unknown, unknown][],

  viewInfo: (view: ArrayBufferView) => {
    const info = viewInfo(view);
    const bufferByteLength = types.isSharedArrayBuffer(info.buffer)
      ? (get.sharedArrayBufferByteLength?.(info.buffer) as number)
      : arrayBufferByteLength(info.buffer as ArrayBuffer);
    return {
      ...info,
      length: types.isDataView(view)
        ? 0
        : (get.typedArrayLength(view) as number),
      bufferByteLength,
    };
  },

  shapeOf: (value: object) => {
    if (isProxy(value)) recordProxy(value);
    return defaultStringifyOperations.shapeOf(value);
  },

  get: (value: object, key: string | number) => readProperty(value, key),
};
