import { types } from 'node:util';
import { WORKFLOW_SERIALIZE } from '@workflow/serde';

// Host constructors that serialization dispatches on (`value instanceof
// global.X`), plus Object/Array, whose statics and prototypes the class
// reducer and devalue's tag lookup read for host-prototype values (hydrated
// step results are host-realm plain objects). The workflow VM's own
// intrinsics are frozen (see vm/index.ts), but host intrinsics are shared
// with the whole process and cannot be frozen — and workflow code can reach
// them (exposed host classes, `structuredClone` results) and plant
// workflow-realm hooks. Verified instead: any dirt declines retention, so a
// planted hook can never execute while a retained VM's inputs serialize.
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

// Host primordials captured at module load — before any workflow code can
// exist in the process — so the checker itself never invokes a live host
// method workflow code could have replaced (host constructors are reachable
// via e.g. `structuredClone(new Map()).constructor`).
const hostMapForEach = Map.prototype.forEach;
const hostSetForEach = Set.prototype.forEach;
// biome-ignore lint/style/noNonNullAssertion: the %TypedArray% buffer getter always exists
const hostTypedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer'
)!.get!;

const TYPED_ARRAY_CONSTRUCTORS = [
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
  // Constructor prototype chains end at host Object.prototype, where an
  // added @@hasInstance would be found by dispatch lookup. (Host
  // Function.prototype's @@hasInstance is spec non-configurable.)
  if (hasOwn(Object.prototype, Symbol.hasInstance)) return false;
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

// The workflow realm's prototype for a supported built-in, but only once the
// sandbox froze it: serialization both executes members on these prototypes
// (iterators, getters) and reads others (`constructor`), so a mutable
// prototype — including one in a realm where freezeSerializationIntrinsics
// never ran — is not provably passive. Host-realm instances of these
// built-ins decline for the same reason: host prototypes cannot be frozen
// and are reachable from workflow code (e.g. via structuredClone results).
function frozenRealmPrototype(
  workflowGlobal: Record<string, any>,
  constructorName: string
): object | undefined {
  const prototype = constructorPrototype(workflowGlobal, constructorName);
  return prototype !== undefined && Object.isFrozen(prototype)
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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== frozenRealmPrototype(workflowGlobal, 'Map')) return false;
  if (!hasNoOwnProperties(value)) return false;
  let passive = true;
  // The captured host forEach iterates via internal slots — no realm
  // members (and no live, replaceable host members) execute.
  hostMapForEach.call(value, (entryValue: unknown, key: unknown) => {
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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== frozenRealmPrototype(workflowGlobal, 'Set')) return false;
  if (!hasNoOwnProperties(value)) return false;
  let passive = true;
  hostSetForEach.call(value, (entryValue: unknown) => {
    passive &&= isPassive(entryValue, workflowGlobal, seen);
  });
  return passive;
}

function isPassiveDate(
  value: object,
  workflowGlobal: Record<string, any>
): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === frozenRealmPrototype(workflowGlobal, 'Date') &&
    hasNoOwnProperties(value)
  );
}

function isPassiveTypedArray(
  value: object,
  workflowGlobal: Record<string, any>
): boolean {
  // Identity against the finite set of the realm's real (frozen) typed-array
  // prototypes — NOT "anything chaining to %TypedArray%": a workflow can
  // manufacture a frozen hostile prototype with a delegating `buffer` getter
  // and setPrototypeOf a real typed array onto it.
  const prototype = Object.getPrototypeOf(value);
  if (
    !TYPED_ARRAY_CONSTRUCTORS.some(
      (name) => prototype === frozenRealmPrototype(workflowGlobal, name)
    )
  ) {
    return false;
  }
  // Own keys on a typed array are exactly its canonical indices.
  if (
    !Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && isArrayIndex(key)
    )
  ) {
    return false;
  }
  // Read the backing buffer via the captured host getter (internal slots
  // work cross-realm); reject SharedArrayBuffer backing.
  return !types.isSharedArrayBuffer(hostTypedArrayBuffer.call(value));
}

function isPassiveArrayBuffer(
  value: object,
  workflowGlobal: Record<string, any>
): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === frozenRealmPrototype(workflowGlobal, 'ArrayBuffer') &&
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
 * reads); and workflow-realm Map/Set/Date/typed arrays/ArrayBuffer whose
 * prototypes the sandbox froze (see freezeSerializationIntrinsics).
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
    isHostDispatchPristine() && isPassive(value, workflowGlobal, new WeakSet())
  );
}
