import { types } from 'node:util';

export type RetainedStepInputPreparation =
  | { readonly retainable: true; readonly value: unknown }
  | { readonly retainable: false };

const typedArrayNames = [
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
] as const;

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
  const ctor = ownDataProperty(realmGlobal, constructorName);
  if (
    (typeof ctor !== 'function' && typeof ctor !== 'object') ||
    ctor === null ||
    types.isProxy(ctor)
  ) {
    return undefined;
  }
  const prototype = ownDataProperty(ctor, 'prototype');
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

function isPassiveMap(
  value: Map<unknown, unknown>,
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  if (!hasAllowedPrototype(value, workflowGlobal, 'Map')) return false;
  if (Reflect.ownKeys(value).length > 0) return false;
  let retainable = true;
  Map.prototype.forEach.call(value, (entryValue: unknown, key: unknown) => {
    retainable &&=
      isPassivelyCloneable(key, workflowGlobal, seen) &&
      isPassivelyCloneable(entryValue, workflowGlobal, seen);
  });
  return retainable;
}

function isPassiveSet(
  value: Set<unknown>,
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  if (!hasAllowedPrototype(value, workflowGlobal, 'Set')) return false;
  if (Reflect.ownKeys(value).length > 0) return false;
  let retainable = true;
  Set.prototype.forEach.call(value, (entryValue: unknown) => {
    retainable &&= isPassivelyCloneable(entryValue, workflowGlobal, seen);
  });
  return retainable;
}

function isPassiveBuiltIn(
  value: object,
  workflowGlobal: Record<string, any>
): boolean | undefined {
  if (types.isDate(value)) {
    return (
      hasAllowedPrototype(value, workflowGlobal, 'Date') &&
      Reflect.ownKeys(value).length === 0
    );
  }
  if (types.isRegExp(value)) {
    return (
      hasAllowedPrototype(value, workflowGlobal, 'RegExp') &&
      Reflect.ownKeys(value).every((key) => key === 'lastIndex')
    );
  }
  if (types.isArrayBuffer(value)) {
    return (
      hasAllowedPrototype(value, workflowGlobal, 'ArrayBuffer') &&
      Reflect.ownKeys(value).length === 0
    );
  }
  if (types.isSharedArrayBuffer(value)) return false;
  if (types.isDataView(value)) {
    return (
      hasAllowedPrototype(value, workflowGlobal, 'DataView') &&
      Reflect.ownKeys(value).length === 0
    );
  }
  if (types.isTypedArray(value)) {
    return (
      Reflect.ownKeys(value).every(
        (key) => typeof key === 'string' && isArrayIndex(key)
      ) &&
      typedArrayNames.some((name) =>
        hasAllowedPrototype(value, workflowGlobal, name)
      )
    );
  }
  return undefined;
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
 * Whether structured cloning `value` can avoid executing workflow-owned code.
 *
 * The retained VM must not observe serialization side effects that a later
 * cold replay cannot reconstruct. Proxy traps, accessors, functions, custom
 * classes, and platform wrappers can all execute workflow code while devalue
 * traverses them, so they deliberately decline the fast path. Plain data and
 * standard in-memory collections are cloned into the host realm before
 * serialization, keeping even mutable VM prototypes out of the write path.
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
  if (types.isMap(value)) return isPassiveMap(value, workflowGlobal, seen);
  if (types.isSet(value)) return isPassiveSet(value, workflowGlobal, seen);

  const builtIn = isPassiveBuiltIn(value, workflowGlobal);
  return builtIn ?? isPassivePlainObject(value, workflowGlobal, seen);
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
