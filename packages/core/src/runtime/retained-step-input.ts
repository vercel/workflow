import { types } from 'node:util';

export type RetainedStepInputPreparation =
  | { readonly retainable: true; readonly value: unknown }
  | { readonly retainable: false };

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
  if (key === 'then' || key === Symbol.toStringTag) return false;
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

export function prepareRetainedStepInput(
  value: unknown,
  workflowGlobal: Record<string, any>
): RetainedStepInputPreparation {
  if (!isPassivelyCloneable(value, workflowGlobal, new WeakSet())) {
    return { retainable: false };
  }
  try {
    return { retainable: true, value: structuredClone(value) };
  } catch {
    return { retainable: false };
  }
}
