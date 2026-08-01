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
 * **Recording is not prevention.** For the recorded cases the determinism
 * hazard is still live: a getter that calls `Math.random()` advances the
 * run's seeded PRNG during serialization, and because serialization happens
 * exactly once and is never replayed, every subsequent draw — including the
 * correlation ids derived from that stream — shifts relative to replay. The
 * report is the only trace of that, which is why the sink exists rather than
 * a bare `console.warn`; acting on it (warning, or refusing to serialize) is
 * left to the caller.
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
   *   never serializable before — the internal-slot reads in the previous
   *   implementation threw on them — so the shape change replaces a crash,
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
 * proxy was built.
 *
 * The step-function reducer must invoke `__closureVarsFn` to read a step's
 * captured closure variables, and the compiler-generated function is a
 * sequence of lexical reads that cannot perturb observable VM state. The
 * *property*, though, is reachable from workflow code, which can replace it
 * with an arbitrary function — so the reducer checks membership here instead
 * of assuming provenance, and reports anything it does not recognize.
 *
 * Be precise about what membership proves: **the function was passed to
 * `useStep`**, not that this package generated it. `useStep` is published on
 * the sandbox global as `Symbol.for('WORKFLOW_USE_STEP')` (see
 * `workflow.ts`), so workflow code can call it directly with a function of
 * its own and have it marked here. That launders a side-effectful function
 * past the report — costing a missing telemetry entry, never incorrect
 * output, and requiring deliberate effort — which is the same trade as the
 * other caveats on {@link isEngineAccessor}. Marking is still worthwhile:
 * closure capture is common, and reporting every step that captures a
 * variable would bury the signal.
 *
 * Closing it properly means branding at the source (a compiler-emitted
 * marker the runtime verifies), which is a compiler change and does not
 * belong here.
 */
const useStepClosureFns = new WeakSet<object>();

/**
 * Marks a function as having been passed to `useStep`. See
 * {@link isUseStepClosureFn} for exactly what that does and does not prove.
 */
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

/**
 * Captures a prototype accessor, or `undefined` when it is absent.
 *
 * This table is built at module scope, so a hard failure here would be an
 * *import-time* crash of `@workflow/core` rather than a degraded
 * serialization path. Not every member is universally available —
 * `URLSearchParams.prototype.size` landed in Node 19.8 / Safari 17, and the
 * WHATWG classes are host-provided rather than ECMAScript intrinsics — so
 * every capture is optional and each use site falls back to not claiming the
 * value (the reducers already treat "did not match" as ordinary).
 */
function intrinsicGetter(
  prototype: object | undefined,
  key: PropertyKey
): ((value: unknown) => unknown) | undefined {
  if (!prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (!descriptor?.get) return undefined;
  return uncurryThis(descriptor.get as (this: unknown) => unknown);
}

/** See {@link intrinsicGetter} — captures a prototype method, if present. */
function intrinsicMethod<T, A extends unknown[], R>(
  method: ((this: T, ...args: A) => R) | undefined
): ((thisArg: T, ...args: A) => R) | undefined {
  return typeof method === 'function' ? uncurryThis(method) : undefined;
}

/** `undefined` when the class itself is absent from the runtime. */
function prototypeOf(ctor: unknown): object | undefined {
  return typeof ctor === 'function'
    ? ((ctor as { prototype?: object }).prototype ?? undefined)
    : undefined;
}

const TypedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype
) as object;

const call = {
  // ECMAScript intrinsics: guaranteed by any engine that can load this
  // package, so these are captured unconditionally.
  dateGetDate: uncurryThis(Date.prototype.getDate),
  dateGetTime: uncurryThis(Date.prototype.getTime),
  dateToISOString: uncurryThis(Date.prototype.toISOString),
  mapEntries: uncurryThis(Map.prototype.entries),
  setValues: uncurryThis(Set.prototype.values),
  numberValueOf: uncurryThis(Number.prototype.valueOf),
  stringValueOf: uncurryThis(String.prototype.valueOf),
  booleanValueOf: uncurryThis(Boolean.prototype.valueOf),
  bigIntValueOf: uncurryThis(
    BigInt.prototype.valueOf as (this: unknown) => bigint
  ),
  // Host-provided (WHATWG) classes: optional.
  headersIterator: intrinsicMethod(
    prototypeOf(globalThis.Headers)?.[Symbol.iterator as never] as
      | ((this: Headers) => Iterator<unknown>)
      | undefined
  ),
  urlSearchParamsToString: intrinsicMethod(
    prototypeOf(globalThis.URLSearchParams)?.toString as
      | ((this: unknown) => string)
      | undefined
  ),
};

const get = {
  regExpSource: intrinsicGetter(RegExp.prototype, 'source'),
  regExpFlags: intrinsicGetter(RegExp.prototype, 'flags'),
  typedArrayTag: intrinsicGetter(TypedArrayPrototype, Symbol.toStringTag) as
    | ((value: unknown) => string | undefined)
    | undefined,
  typedArrayBuffer: intrinsicGetter(TypedArrayPrototype, 'buffer'),
  typedArrayByteOffset: intrinsicGetter(TypedArrayPrototype, 'byteOffset'),
  typedArrayByteLength: intrinsicGetter(TypedArrayPrototype, 'byteLength'),
  typedArrayLength: intrinsicGetter(TypedArrayPrototype, 'length'),
  dataViewBuffer: intrinsicGetter(DataView.prototype, 'buffer'),
  dataViewByteOffset: intrinsicGetter(DataView.prototype, 'byteOffset'),
  dataViewByteLength: intrinsicGetter(DataView.prototype, 'byteLength'),
  arrayBufferByteLength: intrinsicGetter(ArrayBuffer.prototype, 'byteLength'),
  sharedArrayBufferByteLength: intrinsicGetter(
    prototypeOf(globalThis.SharedArrayBuffer),
    'byteLength'
  ),
  urlHref: intrinsicGetter(prototypeOf(globalThis.URL), 'href'),
  // `size` landed in Node 19.8 / Safari 17 — newer than some runtimes the
  // SDK still loads on.
  urlSearchParamsSize: intrinsicGetter(
    prototypeOf(globalThis.URLSearchParams),
    'size'
  ),
};

// ---- Safe access primitives -------------------------------------------------

const { isProxy } = types;

const functionToString = uncurryThis(Function.prototype.toString);

/** Memoized nativeness, keyed on the getter function itself. */
const engineAccessorCache = new WeakMap<object, boolean>();

/**
 * Whether an accessor is provided by the engine or the host, rather than
 * defined by workflow code.
 *
 * Serialization must read some properties that are accessors by construction,
 * and reporting those would drown the signal in noise. Two disjoint cases,
 * both of which occur in practice:
 *
 * - **Engine accessors**, e.g. `stack`, which V8 defines as an *own accessor*
 *   on every Error instance. These are native code, but V8 installs them
 *   per realm, so a VM-realm error's `stack` getter is a VM-realm function.
 *   Detected by nativeness, via the captured host
 *   `Function.prototype.toString` (cross-realm, uninterceptable).
 * - **Host builtins implemented in JavaScript**, e.g. Node's
 *   `DOMException.prototype.message`. These are ordinary functions — so not
 *   native — but they belong to the *host* realm, and workflow code cannot
 *   author a host-realm function. Detected by comparing the function's
 *   prototype against the host `Function.prototype`.
 *
 * Two known limitations, both of which cost a missing telemetry entry rather
 * than incorrect output:
 *
 * - A bound function (`fn.bind(x)`) reports as native code, so
 *   `{ get: sideEffect.bind(null) }` would not be reported.
 * - Workflow code that reaches a host function (any injected global) can read
 *   the host `Function.prototype` off it and `setPrototypeOf` its own getter
 *   to impersonate host provenance.
 *
 * Note also that V8's native `stack` getter can itself invoke a
 * workflow-defined `Error.prepareStackTrace`; that indirection is not
 * detected here.
 */
function isEngineAccessor(getter: object): boolean {
  const cached = engineAccessorCache.get(getter);
  if (cached !== undefined) return cached;

  let provided = false;
  // A callable Proxy reports `function () { [native code] }` from
  // Function.prototype.toString rather than throwing, so it would otherwise
  // be cached as engine-provided and invoked unreported. Its traps are
  // workflow code by definition.
  if (!isProxy(getter)) {
    try {
      provided =
        functionToString(getter as () => unknown).endsWith(
          '{ [native code] }'
        ) || Reflect.getPrototypeOf(getter) === Function.prototype;
    } catch {
      // Not a plain function — treat as workflow code.
      provided = false;
    }
  }
  engineAccessorCache.set(getter, provided);
  return provided;
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
 * Proxies are walked rather than rejected: `Reflect.getPrototypeOf` fires the
 * proxy's `getPrototypeOf` trap, matching `instanceof` semantics, so a
 * proxied instance is still identified when the host prototype is found in
 * its chain. Real values depend on that — Next.js hands the runtime a
 * proxied `NextRequest`. Any proxy encountered along the way is recorded,
 * because its traps are guest-observable.
 */
export function isInstanceOfPrototype(
  value: unknown,
  prototype: object | undefined
): boolean {
  if (!prototype) return false;
  if (value === null || typeof value !== 'object') return false;
  // Proxies are walked rather than rejected. `instanceof` forwards through a
  // proxy's `getPrototypeOf` trap, and real values rely on that: Next.js
  // hands the runtime a proxied `NextRequest`, whose reducer reads ordinary
  // properties and serializes fine through the traps. Answering "not a
  // Request" for it would silently break webhooks. The traps are
  // guest-observable, so the proxy is reported — but the answer stays
  // correct.
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

/**
 * Whether the WHATWG captures a reducer needs are available. When a class or
 * one of its members is missing from the runtime, the corresponding reducer
 * declines to match rather than serializing through a live (patchable)
 * lookup — devalue then treats the value like any other object.
 */
export const canReadUrl = get.urlHref !== undefined;
export const canReadUrlSearchParams =
  get.urlSearchParamsSize !== undefined &&
  call.urlSearchParamsToString !== undefined;
export const canReadHeaders = call.headersIterator !== undefined;

/**
 * Intrinsics read internal slots, which a Proxy does not have — invoking one
 * with a proxy receiver throws, where the pre-existing dynamic read forwarded
 * through the trap. For the (rare) proxy case, fall back to the dynamic read
 * so behavior is unchanged, and record that the traps ran.
 */
function readProxyAware<T>(
  value: unknown,
  viaIntrinsic: (v: unknown) => T,
  viaTrap: (v: unknown) => T
): T {
  if (isProxy(value)) {
    recordProxy(value as object);
    return viaTrap(value);
  }
  return viaIntrinsic(value);
}

/** `URL.prototype.href` getter. Guard with {@link canReadUrl}. */
export const urlHref = (value: unknown): string =>
  readProxyAware(
    value,
    get.urlHref as (v: unknown) => string,
    (v) => (v as URL).href
  );
/**
 * `URLSearchParams.prototype.size` getter. Guard with
 * {@link canReadUrlSearchParams}.
 */
export const urlSearchParamsSize = (value: unknown): number =>
  readProxyAware(
    value,
    get.urlSearchParamsSize as (v: unknown) => number,
    (v) => (v as URLSearchParams).size
  );
/**
 * `URLSearchParams.prototype.toString`. Guard with
 * {@link canReadUrlSearchParams}.
 */
export const urlSearchParamsToString = (value: unknown): string =>
  readProxyAware(
    value,
    call.urlSearchParamsToString as (v: unknown) => string,
    (v) => String(v)
  );

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
  return readProxyAware(
    value,
    (v) => [
      ...(
        call.headersIterator as (
          h: Headers
        ) => IterableIterator<[string, string]>
      )(v as Headers),
    ],
    (v) => Array.from(v as Headers)
  );
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
  const read = (
    dataViewGetter: ((v: unknown) => unknown) | undefined,
    typedArrayGetter: ((v: unknown) => unknown) | undefined
  ) => (isDataView ? dataViewGetter : typedArrayGetter)?.(value);
  return {
    buffer: read(get.dataViewBuffer, get.typedArrayBuffer) as ArrayBufferLike,
    byteOffset: read(
      get.dataViewByteOffset,
      get.typedArrayByteOffset
    ) as number,
    byteLength: read(
      get.dataViewByteLength,
      get.typedArrayByteLength
    ) as number,
  };
}

/** `ArrayBuffer.prototype.byteLength` getter (internal slot read). */
export function arrayBufferByteLength(value: ArrayBuffer): number {
  return (get.arrayBufferByteLength as (v: unknown) => number)(value);
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
    const tag = get.typedArrayTag?.(value);
    return tag !== undefined && KNOWN_VIEW_TAGS.has(tag) ? tag : undefined;
  }
  if (types.isDataView(value)) return 'DataView';
  if (types.isArrayBuffer(value)) return 'ArrayBuffer';
  if (types.isSharedArrayBuffer(value)) return 'SharedArrayBuffer';
  if (types.isNumberObject(value)) return 'Number';
  if (types.isStringObject(value)) return 'String';
  if (types.isBooleanObject(value)) return 'Boolean';
  if (types.isBigIntObject(value)) return 'BigInt';
  if (canReadUrl && isInstanceOfPrototype(value, URL.prototype)) return 'URL';
  if (
    canReadUrlSearchParams &&
    isInstanceOfPrototype(value, URLSearchParams.prototype)
  ) {
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
    if (canReadUrl && isInstanceOfPrototype(value, URL.prototype)) {
      return urlHref(value);
    }
    if (
      canReadUrlSearchParams &&
      isInstanceOfPrototype(value, URLSearchParams.prototype)
    ) {
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
        : (get.typedArrayLength?.(view) as number),
      bufferByteLength,
    };
  },

  shapeOf: (value: object) => {
    if (isProxy(value)) recordProxy(value);
    return defaultStringifyOperations.shapeOf(value);
  },

  get: (value: object, key: string | number) => readProperty(value, key),
};
