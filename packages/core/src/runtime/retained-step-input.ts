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

function hasAllowedPrototype(
  value: object,
  workflowGlobal: Record<string, any>,
  constructorName: string
): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype ===
      globalThis[constructorName as keyof typeof globalThis]?.prototype ||
    prototype === workflowGlobal[constructorName]?.prototype
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
    if (!hasAllowedPrototype(value, workflowGlobal, 'Array')) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return false;
      if (key === 'then' || key === Symbol.toStringTag) return false;
      if (typeof key !== 'string' || !isArrayIndex(key)) {
        if (descriptor.enumerable) return false;
        continue;
      }
      if (!('value' in descriptor)) return false;
      if (!isPassivelyCloneable(descriptor.value, workflowGlobal, seen)) {
        return false;
      }
    }
    return true;
  }

  if (types.isMap(value)) {
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

  if (types.isSet(value)) {
    if (!hasAllowedPrototype(value, workflowGlobal, 'Set')) return false;
    if (Reflect.ownKeys(value).length > 0) return false;
    let retainable = true;
    Set.prototype.forEach.call(value, (entryValue: unknown) => {
      retainable &&= isPassivelyCloneable(entryValue, workflowGlobal, seen);
    });
    return retainable;
  }

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
      typedArrayNames.some(
        (name) =>
          workflowGlobal[name] !== undefined &&
          hasAllowedPrototype(value, workflowGlobal, name)
      )
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== workflowGlobal.Object?.prototype
  ) {
    return false;
  }

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return false;
    if (typeof key === 'symbol') {
      if (key === Symbol.toStringTag) return false;
      if (descriptor.enumerable) return false;
      continue;
    }
    if (!descriptor.enumerable) {
      if (key === 'constructor' || key === 'then') return false;
      continue;
    }
    if (key === '__proto__' || !('value' in descriptor)) return false;
    if (!isPassivelyCloneable(descriptor.value, workflowGlobal, seen)) {
      return false;
    }
  }
  return true;
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
