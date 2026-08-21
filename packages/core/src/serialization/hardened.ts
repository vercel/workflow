/**
 * Hardened introspection for serializing values that may originate inside a
 * workflow VM (`node:vm`) sandbox realm.
 *
 * Serialization runs on the host, but the values it inspects were
 * constructed by workflow code, so a naive dynamic operation like
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
 *   internal-slot probes) instead of `instanceof` / `Object.prototype.toString`,
 *   which makes it immune to `Symbol.hasInstance`, `Symbol.toStringTag`, and
 *   reassigned globals.
 * - **Extraction** goes through intrinsics captured at module load (host
 *   boot, before any workflow code runs). Internal slots are realm-agnostic,
 *   so host intrinsics read VM-realm objects without touching the sandbox's
 *   (patchable) prototypes.
 * - **Property access** reads through descriptors, so plain data never
 *   invokes anything. Where workflow code *must* run because the data itself
 *   lives behind it (getters, proxies, custom `[WORKFLOW_SERIALIZE]`
 *   methods, `toString()` on toStringTag-branded objects such as Temporal
 *   polyfills), the execution is preserved for compatibility and recorded
 *   in the active {@link GuestCodeStats} sink, so callers (e.g. a retained-VM
 *   gate) can react.
 *
 * **Recording is not prevention.** For the recorded cases the determinism
 * hazard is still live: a getter that calls `Math.random()` advances the
 * run's seeded PRNG during serialization, and because serialization happens
 * exactly once and is never replayed, every subsequent draw (including the
 * correlation ids derived from that stream) shifts relative to replay. The
 * report is the only trace of that; acting on it (warning, demoting a
 * retained VM to replay) is left to the caller.
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
   * - `proxy`: a proxy was introspected, firing its traps. Note this also
   *   implies a **shape change**: brand checks answer "not that type" for a
   *   proxy, so a proxied `Map` serializes as a plain object rather than as a
   *   `Map`, and this report is the only evidence of it. (Such values were
   *   never serializable before, since the internal-slot reads in the previous
   *   implementation threw on them, so the shape change replaces a crash,
   *   but it is silent.)
   * - `method`: a workflow-defined function was invoked (e.g. a custom
   *   `[WORKFLOW_SERIALIZE]` serializer, `toString()` on a
   *   `Symbol.toStringTag`-branded object, a duck-typed `getTime()`, or a
   *   `__closureVarsFn` this package did not generate)
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

/**
 * Closure-variable functions that arrived through `useStep` when a step
 * proxy was built. The step-function reducer must invoke `__closureVarsFn`,
 * and the compiler-generated function is a pure sequence of lexical reads.
 * But the *property* is reachable from workflow code, which can replace it
 * with an arbitrary function. The reducer checks membership here instead of
 * assuming provenance, and reports anything it does not recognize.
 *
 * Membership proves the function was passed to `useStep`, not that the
 * compiler generated it: workflow code can call `useStep` directly and
 * launder a side-effectful function past the report. That costs a missing
 * report entry, never incorrect output; closing it means branding at the
 * compiler, which does not belong here.
 */
const useStepClosureFns = new WeakSet<object>();

/** Marks a function as having been passed to `useStep`. */
export function markUseStepClosureFn<T extends object>(fn: T): T {
  useStepClosureFns.add(fn);
  return fn;
}

/** Whether `fn` was marked by {@link markUseStepClosureFn}. */
export function isUseStepClosureFn(fn: unknown): boolean {
  return typeof fn === 'function' && useStepClosureFns.has(fn as object);
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
// Captured at module load (host boot, before any workflow bundle can run)
// and invoked with explicit receivers, so no lookup ever resolves through a
// sandbox-reachable prototype. Every member below exists on every supported
// engine (Node 18+), so a missing one is a bug in this table: fail at import
// rather than serialize through a live (patchable) lookup later.

const uncurryThis = Function.prototype.bind.bind(Function.prototype.call) as <
  T,
  A extends unknown[],
  R,
>(
  fn: (this: T, ...args: A) => R
) => (thisArg: T, ...args: A) => R;

function protoGetter<T>(
  prototype: object,
  key: PropertyKey
): (value: unknown) => T {
  const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
  if (!getter) {
    throw new Error(`Missing intrinsic getter: ${String(key)}`);
  }
  return uncurryThis(getter) as (value: unknown) => T;
}

// ECMAScript intrinsics. All read internal slots, so they work on values
// from any realm and are unaffected by prototype patching in any realm.

/** `Date.prototype.getDate`, for invalid-date checks. */
export const dateGetDate = uncurryThis(Date.prototype.getDate);
/** `Date.prototype.getTime`. */
export const dateGetTime = uncurryThis(Date.prototype.getTime);
/** `Date.prototype.toISOString`. */
export const dateToISOString = uncurryThis(Date.prototype.toISOString);
/** `RegExp.prototype.source` getter. */
export const regExpSource = protoGetter<string>(RegExp.prototype, 'source');
/** `RegExp.prototype.flags` getter. */
export const regExpFlags = protoGetter<string>(RegExp.prototype, 'flags');
/** `ArrayBuffer.prototype.byteLength` getter (internal slot read). */
export const arrayBufferByteLength = protoGetter<number>(
  ArrayBuffer.prototype,
  'byteLength'
);

const mapEntries = uncurryThis(Map.prototype.entries);
const setValues = uncurryThis(Set.prototype.values);
const numberValueOf = uncurryThis(Number.prototype.valueOf);
const stringValueOf = uncurryThis(String.prototype.valueOf);
const booleanValueOf = uncurryThis(Boolean.prototype.valueOf);
const bigIntValueOf = uncurryThis(
  BigInt.prototype.valueOf as (this: unknown) => bigint
);

const TypedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = protoGetter<string | undefined>(
  TypedArrayPrototype,
  Symbol.toStringTag
);
const typedArrayBuffer = protoGetter<ArrayBufferLike>(
  TypedArrayPrototype,
  'buffer'
);
const typedArrayByteOffset = protoGetter<number>(
  TypedArrayPrototype,
  'byteOffset'
);
const typedArrayByteLength = protoGetter<number>(
  TypedArrayPrototype,
  'byteLength'
);
const typedArrayLength = protoGetter<number>(TypedArrayPrototype, 'length');
const dataViewBuffer = protoGetter<ArrayBufferLike>(
  DataView.prototype,
  'buffer'
);
const dataViewByteOffset = protoGetter<number>(
  DataView.prototype,
  'byteOffset'
);
const dataViewByteLength = protoGetter<number>(
  DataView.prototype,
  'byteLength'
);
const sharedArrayBufferByteLength = protoGetter<number>(
  SharedArrayBuffer.prototype,
  'byteLength'
);

// Host (WHATWG) classes. Injected into the sandbox by reference, so
// instances from any realm carry these prototypes, and the shared
// prototypes are reachable from workflow code, which makes the boot-time
// capture (rather than a live lookup) load-bearing.
const headersIterator = uncurryThis(Headers.prototype[Symbol.iterator]);
const urlHrefGetter = protoGetter<string>(URL.prototype, 'href');
const urlSearchParamsToStringMethod = uncurryThis(
  URLSearchParams.prototype.toString
);

// ---- Safe access primitives -------------------------------------------------

const { isProxy } = types;

const functionToString = uncurryThis(Function.prototype.toString);

/**
 * Whether an accessor is provided by the engine or the host, rather than
 * defined by workflow code. Serialization must read some properties that are
 * accessors by construction (V8 defines `stack` as an own accessor on every
 * Error instance; Node implements `DOMException.prototype.message` in
 * JavaScript), and reporting those would drown the signal in noise.
 *
 * - Engine accessors are native code, detected via the captured host
 *   `Function.prototype.toString` (cross-realm, uninterceptable). Bound
 *   functions and callable Proxies also present as native code but run
 *   workflow code, so both are excluded first.
 * - Host builtins implemented in JavaScript are ordinary functions, but they
 *   belong to the host realm, detected by comparing the function's
 *   prototype against the host `Function.prototype`. Workflow code that
 *   reaches a host function can `setPrototypeOf` its own getter to
 *   impersonate this; that costs a missing report entry, never incorrect
 *   output.
 *
 * V8's native `stack` getter can itself invoke a workflow-defined
 * `Error.prepareStackTrace`; that indirection is not detected here.
 */
function isEngineAccessor(getter: object): boolean {
  if (isProxy(getter)) return false;
  // A bound function stringifies as native code but runs its target. The
  // one passive distinguisher V8 exposes is the `name` own property
  // (`"bound fn"`). Workflow code can redefine the name to hide it; that
  // costs a missing report entry, like the other impersonation caveats.
  const name = Object.getOwnPropertyDescriptor(getter, 'name')?.value;
  if (typeof name === 'string' && name.startsWith('bound ')) return false;
  return (
    functionToString(getter as () => unknown).endsWith('{ [native code] }') ||
    Reflect.getPrototypeOf(getter) === Function.prototype
  );
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
      // a proxy in the prototype chain: its traps answer the lookup
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
 * URLSearchParams, DOMException), where the instances (from any realm the
 * host handed the class to) carry the host prototype in their chain.
 *
 * Proxies are walked rather than rejected: `Reflect.getPrototypeOf` fires
 * the proxy's `getPrototypeOf` trap, matching `instanceof` semantics, and
 * real values depend on that: Next.js hands the runtime a proxied
 * `NextRequest`, and answering "not a Request" for it would silently break
 * webhooks. The traps are guest-observable, so the proxy is recorded.
 */
export function isInstanceOfPrototype(
  value: unknown,
  prototype: object | undefined
): boolean {
  if (!prototype) return false;
  if (value === null || typeof value !== 'object') return false;
  if (isProxy(value)) recordProxy(value);
  let current: object | null = Reflect.getPrototypeOf(value);
  while (current !== null) {
    if (current === prototype) return true;
    if (isProxy(current)) recordProxy(current);
    current = Reflect.getPrototypeOf(current);
  }
  return false;
}

// ---- Intrinsic-backed extraction helpers (used by the reducers) -------------
//
// Intrinsics read internal slots, which a Proxy does not have: invoking one
// with a proxy receiver throws, where the pre-existing dynamic read forwarded
// through the trap. For the (rare) proxy case, fall back to the dynamic read
// so behavior is unchanged, and record that the traps ran.

/** `URL.prototype.href` getter. */
export function urlHref(value: URL): string {
  if (isProxy(value)) {
    recordProxy(value);
    return value.href;
  }
  return urlHrefGetter(value);
}

/** `URLSearchParams.prototype.toString`: returns `''` iff empty. */
export function urlSearchParamsToString(value: URLSearchParams): string {
  if (isProxy(value)) {
    recordProxy(value);
    return String(value);
  }
  return urlSearchParamsToStringMethod(value);
}

/**
 * Iterates a Headers instance through the captured host iterator, so the
 * iterator object, and its `next`, are host-realm.
 */
export function headersToEntries(value: Headers): [string, string][] {
  if (isProxy(value)) {
    recordProxy(value);
    return Array.from(value) as [string, string][];
  }
  return [...headersIterator(value)] as [string, string][];
}

/**
 * Iterates a genuine Map's entries entirely through host intrinsics: the
 * iterator object is created by the host `Map.prototype.entries`, so its
 * realm, and therefore its `next`, is the host's, not the sandbox's.
 */
export function mapToEntries(
  value: Map<unknown, unknown>
): [unknown, unknown][] {
  return [...mapEntries(value)];
}

/** See {@link mapToEntries}. */
export function setToValues(value: Set<unknown>): unknown[] {
  return [...setValues(value)];
}

/**
 * The bytes of an `ArrayBufferView`, read via internal-slot getters, so
 * own-property shadowing and prototype patches cannot change which bytes
 * are serialized.
 */
export function viewInfo(value: ArrayBufferView): {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
} {
  if (types.isDataView(value)) {
    return {
      buffer: dataViewBuffer(value),
      byteOffset: dataViewByteOffset(value),
      byteLength: dataViewByteLength(value),
    };
  }
  return {
    buffer: typedArrayBuffer(value),
    byteOffset: typedArrayByteOffset(value),
    byteLength: typedArrayByteLength(value),
  };
}

// ---- Hardened devalue operations ---------------------------------------------
//
// The workflow reducers claim most special types before devalue's built-in
// handling runs, so these operations mainly govern plain objects, arrays,
// boxed primitives, thenable probes, and classification (`tagOf`), which
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
    const tag = typedArrayTag(value);
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
 * but through descriptors: a data-property tag (the common case, e.g.
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
      // A proxy's classification is answered by its traps, which is the
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
    if (types.isNumberObject(boxed)) return numberValueOf(boxed);
    if (types.isStringObject(boxed)) return stringValueOf(boxed);
    if (types.isBooleanObject(boxed)) return booleanValueOf(boxed);
    return bigIntValueOf(boxed);
  },

  toISOString: (date: Date) =>
    Number.isNaN(dateGetDate(date)) ? '' : dateToISOString(date),

  toStringValue: (value: object) => {
    // Reached for URL / URLSearchParams (when the reducers did not claim
    // them, e.g. instances of a different realm's classes) and for
    // toStringTag-branded objects like Temporal polyfills, whose string
    // form only their own toString() can produce.
    if (isInstanceOfPrototype(value, URL.prototype)) {
      return urlHref(value as URL);
    }
    if (isInstanceOfPrototype(value, URLSearchParams.prototype)) {
      return urlSearchParamsToString(value as URLSearchParams);
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
    return {
      ...info,
      // devalue only reads `length` for typed-array subviews; DataView
      // subviews are encoded from `byteLength`.
      length: types.isDataView(view) ? 0 : typedArrayLength(view),
      bufferByteLength: types.isSharedArrayBuffer(info.buffer)
        ? sharedArrayBufferByteLength(info.buffer)
        : arrayBufferByteLength(info.buffer),
    };
  },

  shapeOf: (value: object) => {
    if (isProxy(value)) recordProxy(value);
    return defaultStringifyOperations.shapeOf(value);
  },

  get: (value: object, key: string | number) => readProperty(value, key),
};
