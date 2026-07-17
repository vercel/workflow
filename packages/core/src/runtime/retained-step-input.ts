import { types } from 'node:util';
import { runInContext, createContext as vmCreateContext } from 'node:vm';
import { WORKFLOW_SERIALIZE } from '@workflow/serde';

export type RetainedStepInputPreparation =
  | { readonly retainable: true; readonly value: unknown }
  | { readonly retainable: false };

// A pristine realm nothing else can reach: clones are built from its Object
// and Array so their entire prototype chain is immune to intrinsic mutation
// in both the workflow realm and the host realm (workflow code can obtain
// host-realm objects through APIs like `structuredClone` and vandalize their
// prototypes).
const pristineRealm = runInContext(
  '({ Object, Array })',
  vmCreateContext()
) as { Object: ObjectConstructor; Array: ArrayConstructor };

// Host constructors that serialization dispatches on when the clone is
// serialized under the host global — plus Object/Array, whose statics and
// prototypes the class reducer and devalue's tag lookup read for
// host-prototype originals (hydrated step results are host-realm objects).
// The workflow VM's own intrinsics are frozen (see vm/index.ts), but host
// intrinsics are shared with the whole process and cannot be frozen, so
// dispatch-pristineness is verified instead. Any dirt declines retention
// BEFORE a clone exists, so a spoofed predicate can never observe (or
// capture) a pristine-realm object.
const HOST_DISPATCH_CONSTRUCTORS = [
  'Object',
  'Array',
  'Function',
  'Map',
  'Set',
  'Date',
  'RegExp',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Headers',
  'URL',
  'URLSearchParams',
  'DOMException',
  'AbortController',
  'AbortSignal',
  'Request',
  'Response',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
] as const;

function hasOwn(target: object, key: string | symbol): boolean {
  return Object.getOwnPropertyDescriptor(target, key) !== undefined;
}

function isHostDispatchPristine(): boolean {
  const hostGlobal = globalThis as unknown as Record<string, unknown>;
  for (const name of HOST_DISPATCH_CONSTRUCTORS) {
    const constructor = hostGlobal[name];
    if (constructor === undefined) continue;
    if (hasOwn(constructor as object, Symbol.hasInstance)) return false;
  }
  for (const constructor of [Object, Array]) {
    if (
      hasOwn(constructor, WORKFLOW_SERIALIZE) ||
      hasOwn(constructor, 'classId')
    ) {
      return false;
    }
  }
  for (const [prototype, constructor] of [
    [Object.prototype, Object],
    [Array.prototype, Array],
  ] as const) {
    if (
      hasOwn(prototype, Symbol.toStringTag) ||
      ownDataProperty(prototype, 'constructor') !== constructor
    ) {
      return false;
    }
  }
  return true;
}

// Own data-property read that never performs a property Get — workflow code
// can redefine its globals (or their `prototype` slots) with accessors, and
// validation must not execute workflow-owned code.
function ownDataProperty(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function constructorPrototype(
  realmGlobal: Record<string, any>,
  constructorName: string
): object | undefined {
  const constructor = ownDataProperty(realmGlobal, constructorName);
  if (
    (typeof constructor !== 'function' && typeof constructor !== 'object') ||
    constructor === null ||
    types.isProxy(constructor)
  ) {
    return undefined;
  }
  const prototype = ownDataProperty(constructor, 'prototype');
  return typeof prototype === 'object' &&
    prototype !== null &&
    !types.isProxy(prototype)
    ? prototype
    : undefined;
}

function hasAllowedPrototype(
  value: object,
  workflowGlobal: Record<string, any>,
  constructorName: string
): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype ===
      constructorPrototype(
        globalThis as unknown as Record<string, any>,
        constructorName
      ) || prototype === constructorPrototype(workflowGlobal, constructorName)
  );
}

// Cloneable exotics (per the structured-clone spec) whose devalue/reducer
// serialization reads prototype methods, getters, or iterators the workflow
// realm can mutate — serializing them is not provably passive, so they
// decline the fast path even when their prototype identity looks intact.
function isSlotBearingExotic(value: object): boolean {
  return (
    types.isMap(value) ||
    types.isSet(value) ||
    types.isDate(value) ||
    types.isRegExp(value) ||
    types.isArrayBuffer(value) ||
    types.isSharedArrayBuffer(value) ||
    types.isDataView(value) ||
    types.isTypedArray(value) ||
    types.isBoxedPrimitive(value) ||
    types.isNativeError(value) ||
    types.isPromise(value) ||
    types.isArgumentsObject(value)
  );
}

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < 2 ** 32 - 1 &&
    String(index) === key
  );
}

function isPassiveArrayProperty(
  array: unknown[],
  key: string | symbol,
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  if (key === 'length') return true;
  const descriptor = Object.getOwnPropertyDescriptor(array, key);
  if (!descriptor) return false;
  // `then` and `constructor` are read by serialization dispatch even when
  // non-enumerable (thenable assimilation, the class reducer).
  if (key === 'then' || key === 'constructor' || key === Symbol.toStringTag) {
    return false;
  }
  if (typeof key !== 'string' || !isArrayIndex(key)) {
    return !descriptor.enumerable;
  }
  // Non-enumerable indices are dropped by structuredClone but persisted by
  // devalue, so they must decline the fast path.
  return (
    descriptor.enumerable === true &&
    'value' in descriptor &&
    isPassivelyCloneable(descriptor.value, workflowGlobal, seen)
  );
}

function isPassiveArray(
  value: unknown[],
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  return (
    hasAllowedPrototype(value, workflowGlobal, 'Array') &&
    Reflect.ownKeys(value).every((key) =>
      isPassiveArrayProperty(value, key, workflowGlobal, seen)
    )
  );
}

function isPassiveObjectProperty(
  object: object,
  key: string | symbol,
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return false;
  if (typeof key === 'symbol') {
    return key !== Symbol.toStringTag && !descriptor.enumerable;
  }
  if (!descriptor.enumerable) {
    return key !== 'constructor' && key !== 'then';
  }
  return (
    key !== '__proto__' &&
    'value' in descriptor &&
    isPassivelyCloneable(descriptor.value, workflowGlobal, seen)
  );
}

function isPassivePlainObject(
  value: object,
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  if (!hasAllowedPrototype(value, workflowGlobal, 'Object')) return false;
  return Reflect.ownKeys(value).every((key) =>
    isPassiveObjectProperty(value, key, workflowGlobal, seen)
  );
}

/**
 * Whether structured cloning `value` is provably byte-equivalent to the
 * ordinary VM serialization AND cannot execute workflow-owned code.
 *
 * The retained VM must not observe serialization side effects that a later
 * cold replay cannot reconstruct, and the durable bytes must not depend on
 * `WORKFLOW_RETAINED_VM`. Only primitives, plain objects, and plain arrays
 * qualify: devalue traverses them exclusively through own-property reads
 * (`Object.keys`, `Object.hasOwn` + indices), so no workflow-realm prototype
 * state can influence the output. Everything else — proxies, accessors,
 * functions, custom classes, and built-ins like Map/Set/Date whose
 * serialization consults mutable realm prototypes (iterators, getters) —
 * declines the fast path and serializes through the ordinary VM traversal.
 */
function isPassivelyCloneable(
  value: unknown,
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (typeof value !== 'object' || types.isProxy(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);

  if (Array.isArray(value)) {
    return isPassiveArray(value, workflowGlobal, seen);
  }
  if (isSlotBearingExotic(value)) return false;
  return isPassivePlainObject(value, workflowGlobal, seen);
}

// Deep-copy walker-validated plain data into the pristine realm, copying
// exactly what devalue serializes: dense/sparse own indices for arrays and
// own enumerable string properties for objects. All reads are data-property
// reads — the walker already rejected everything else.
function cloneIntoPristineRealm(
  value: unknown,
  copies: WeakMap<object, unknown>
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy = new pristineRealm.Array(value.length) as unknown[];
    copies.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !isArrayIndex(key)) continue;
      copy[Number(key)] = cloneIntoPristineRealm(
        (value as unknown as Record<string, unknown>)[key],
        copies
      );
    }
    return copy;
  }

  const copy = new pristineRealm.Object() as Record<string, unknown>;
  copies.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = cloneIntoPristineRealm(
      (value as Record<string, unknown>)[key],
      copies
    );
  }
  return copy;
}

export function prepareRetainedStepInput(
  value: unknown,
  workflowGlobal: Record<string, any>
): RetainedStepInputPreparation {
  if (
    !isHostDispatchPristine() ||
    !isPassivelyCloneable(value, workflowGlobal, new WeakSet())
  ) {
    return { retainable: false };
  }
  return {
    retainable: true,
    value: cloneIntoPristineRealm(value, new WeakMap()),
  };
}
