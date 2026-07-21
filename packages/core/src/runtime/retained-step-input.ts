import { types } from 'node:util';
import {
  getSerializationPins,
  verifySerializationPins,
} from '../vm/serialization-pins.js';

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
  // Only own enumerable data indices are passive. Anything hidden — symbol
  // tags, non-enumerable properties, accessors — can be observed by
  // serialization dispatch (reducer probes, thenable checks, the class
  // reducer) and can execute workflow code when read.
  return (
    typeof key === 'string' &&
    isArrayIndex(key) &&
    descriptor.enumerable === true &&
    'value' in descriptor &&
    isPassive(descriptor.value, workflowGlobal, seen)
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

// Instances of the supported built-ins must carry no own properties at all:
// serialization never reads own properties on them, but an own accessor or
// symbol could still be observed through other dispatch lookups, and clean
// instances are the overwhelmingly common case anyway.
function hasNoOwnProperties(value: object): boolean {
  return Reflect.ownKeys(value).length === 0;
}

function isPassiveMap(
  value: Map<unknown, unknown>,
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  const pins = getSerializationPins(workflowGlobal);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== pins?.mapPrototype && prototype !== Map.prototype) {
    return false;
  }
  if (!hasNoOwnProperties(value)) return false;
  let passive = true;
  // Host forEach iterates via internal slots — no realm members execute.
  Map.prototype.forEach.call(value, (entryValue: unknown, key: unknown) => {
    passive &&=
      isPassive(key, workflowGlobal, seen) &&
      isPassive(entryValue, workflowGlobal, seen);
  });
  return passive;
}

function isPassiveSet(
  value: Set<unknown>,
  workflowGlobal: Record<string, any>,
  seen: WeakSet<object>
): boolean {
  const pins = getSerializationPins(workflowGlobal);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== pins?.setPrototype && prototype !== Set.prototype) {
    return false;
  }
  if (!hasNoOwnProperties(value)) return false;
  let passive = true;
  Set.prototype.forEach.call(value, (entryValue: unknown) => {
    passive &&= isPassive(entryValue, workflowGlobal, seen);
  });
  return passive;
}

function isPassiveDate(
  value: object,
  workflowGlobal: Record<string, any>
): boolean {
  const pins = getSerializationPins(workflowGlobal);
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === pins?.datePrototype || prototype === Date.prototype) &&
    hasNoOwnProperties(value)
  );
}

function isPassiveTypedArray(
  value: object,
  workflowGlobal: Record<string, any>
): boolean {
  const pins = getSerializationPins(workflowGlobal);
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || types.isProxy(prototype)) return false;
  const parent = Object.getPrototypeOf(prototype);
  const hostTypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  if (
    parent !== pins?.typedArrayPrototype &&
    parent !== hostTypedArrayPrototype
  ) {
    return false;
  }
  // The measured getters resolve on %TypedArray%.prototype; a shadow on the
  // subclass prototype (e.g. Float32Array.prototype) would intercept them.
  for (const name of ['buffer', 'byteOffset', 'byteLength']) {
    if (Object.getOwnPropertyDescriptor(prototype, name)) return false;
  }
  // Own keys on a typed array are exactly its canonical indices.
  if (
    !Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && isArrayIndex(key)
    )
  ) {
    return false;
  }
  // The pinned/native getter is safe to invoke; reject SharedArrayBuffer
  // backing (cross-thread mutation is unserializable either way).
  const bufferGetter = (
    pins !== undefined && parent === pins.typedArrayPrototype
      ? pins.typedArrayBuffer
      : Object.getOwnPropertyDescriptor(hostTypedArrayPrototype, 'buffer')?.get
  ) as (() => unknown) | undefined;
  return (
    bufferGetter !== undefined &&
    !types.isSharedArrayBuffer(bufferGetter.call(value))
  );
}

function isPassiveArrayBuffer(
  value: object,
  workflowGlobal: Record<string, any>
): boolean {
  const pins = getSerializationPins(workflowGlobal);
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === pins?.arrayBufferPrototype ||
      prototype === ArrayBuffer.prototype) &&
    hasNoOwnProperties(value)
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
  // Only own enumerable string-keyed data properties are passive. Anything
  // hidden — symbol tags, non-enumerable properties, accessors — can be
  // observed by serialization dispatch (reducer probes like `.signal`,
  // thenable checks, the class reducer) and can execute workflow code.
  return (
    typeof key === 'string' &&
    key !== '__proto__' &&
    descriptor.enumerable === true &&
    'value' in descriptor &&
    isPassive(descriptor.value, workflowGlobal, seen)
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
 * Whether serializing `value` through the ordinary pipeline provably executes
 * no workflow code and draws no workflow-realm randomness.
 *
 * Retained sessions keep running after suspension, so serialization side
 * effects there would desync the live VM from what a cold replay
 * reconstructs (replay never re-serializes an already-created step). The
 * bytes themselves cannot differ by mode — serialization happens once and
 * every mode reads the same `step_created` event — so passivity is the only
 * property retention needs.
 *
 * Passive values: primitives; plain objects and arrays (own enumerable
 * string-keyed data properties only — devalue traverses these purely via own
 * reads); and Map/Set/Date/typed arrays/ArrayBuffer instances whose measured
 * prototype members are verified pinned (see vm/serialization-pins.ts).
 * Everything else — proxies, accessors, functions, custom classes, RegExp,
 * hidden keys — declines, serializes exactly the same way, and the session
 * falls back to ordinary replay for that boundary.
 */
function isPassive(
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

  if (Array.isArray(value)) return isPassiveArray(value, workflowGlobal, seen);
  if (types.isMap(value)) return isPassiveMap(value, workflowGlobal, seen);
  if (types.isSet(value)) return isPassiveSet(value, workflowGlobal, seen);
  if (types.isDate(value)) return isPassiveDate(value, workflowGlobal);
  if (types.isTypedArray(value)) {
    return isPassiveTypedArray(value, workflowGlobal);
  }
  if (types.isArrayBuffer(value)) {
    return isPassiveArrayBuffer(value, workflowGlobal);
  }
  if (
    types.isSharedArrayBuffer(value) ||
    types.isRegExp(value) ||
    types.isDataView(value) ||
    types.isBoxedPrimitive(value) ||
    types.isNativeError(value) ||
    types.isPromise(value) ||
    types.isArgumentsObject(value)
  ) {
    return false;
  }
  return isPassivePlainObject(value, workflowGlobal, seen);
}

export function isRetainedSerializationPassive(
  value: unknown,
  workflowGlobal: Record<string, any>
): boolean {
  return (
    verifySerializationPins(workflowGlobal) &&
    isPassive(value, workflowGlobal, new WeakSet())
  );
}
