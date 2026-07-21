/**
 * Pinned copies of the workflow-realm prototype members that step-argument
 * serialization executes, captured at context creation before any workflow
 * code runs.
 *
 * The retained-VM fast path serializes step inputs through the ordinary
 * serialization pipeline, which is only safe when that traversal provably
 * executes no workflow code. For plain objects and arrays the traversal is
 * own-property reads only; for the supported built-ins it also runs a small,
 * measured set of prototype members (iteration protocols and getters — see
 * the "touches only pinned members" test, which derives this list
 * empirically). If workflow code replaced any of them, serializing that type
 * would execute the replacement, so retention verifies each member is still
 * the pinned original. Host-realm instances need no verification: their
 * members run host code, which cannot reach the retained VM's state.
 */

interface SerializationPins {
  readonly mapPrototype: object;
  readonly mapIterator: unknown;
  readonly mapIteratorPrototype: object;
  readonly mapIteratorNext: unknown;
  readonly setPrototype: object;
  readonly setIterator: unknown;
  readonly setIteratorPrototype: object;
  readonly setIteratorNext: unknown;
  readonly datePrototype: object;
  readonly dateGetDate: unknown;
  readonly dateToISOString: unknown;
  readonly typedArrayPrototype: object;
  readonly typedArrayBuffer: unknown;
  readonly typedArrayByteOffset: unknown;
  readonly typedArrayByteLength: unknown;
  readonly arrayBufferPrototype: object;
  readonly arrayBufferByteLength: unknown;
}

const registry = new WeakMap<object, SerializationPins>();

function ownValue(target: object, key: string | symbol): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function ownGetter(target: object, key: string | symbol): unknown {
  return Object.getOwnPropertyDescriptor(target, key)?.get;
}

export function registerSerializationPins(g: typeof globalThis): void {
  const mapPrototype = g.Map.prototype;
  const mapIteratorPrototype = Object.getPrototypeOf(
    new g.Map()[Symbol.iterator]()
  ) as object;
  const setPrototype = g.Set.prototype;
  const setIteratorPrototype = Object.getPrototypeOf(
    new g.Set()[Symbol.iterator]()
  ) as object;
  // `g.Date` may already be the deterministic wrapper; its `prototype`
  // data property is the realm's real Date.prototype either way.
  const datePrototype = ownValue(g.Date, 'prototype') as object;
  const typedArrayPrototype = Object.getPrototypeOf(
    g.Uint8Array.prototype
  ) as object;
  const arrayBufferPrototype = g.ArrayBuffer.prototype;

  registry.set(g, {
    mapPrototype,
    mapIterator: ownValue(mapPrototype, Symbol.iterator),
    mapIteratorPrototype,
    mapIteratorNext: ownValue(mapIteratorPrototype, 'next'),
    setPrototype,
    setIterator: ownValue(setPrototype, Symbol.iterator),
    setIteratorPrototype,
    setIteratorNext: ownValue(setIteratorPrototype, 'next'),
    datePrototype,
    dateGetDate: ownValue(datePrototype, 'getDate'),
    dateToISOString: ownValue(datePrototype, 'toISOString'),
    typedArrayPrototype,
    typedArrayBuffer: ownGetter(typedArrayPrototype, 'buffer'),
    typedArrayByteOffset: ownGetter(typedArrayPrototype, 'byteOffset'),
    typedArrayByteLength: ownGetter(typedArrayPrototype, 'byteLength'),
    arrayBufferPrototype,
    arrayBufferByteLength: ownGetter(arrayBufferPrototype, 'byteLength'),
  });
}

export function getSerializationPins(
  g: Record<string, any>
): SerializationPins | undefined {
  return registry.get(g);
}

/**
 * Whether every pinned member is still the original. All reads are
 * own-descriptor reads — verification itself can never execute workflow code.
 */
export function verifySerializationPins(g: Record<string, any>): boolean {
  const pins = registry.get(g);
  if (!pins) return false;
  return (
    ownValue(pins.mapPrototype, Symbol.iterator) === pins.mapIterator &&
    ownValue(pins.mapIteratorPrototype, 'next') === pins.mapIteratorNext &&
    ownValue(pins.setPrototype, Symbol.iterator) === pins.setIterator &&
    ownValue(pins.setIteratorPrototype, 'next') === pins.setIteratorNext &&
    ownValue(pins.datePrototype, 'getDate') === pins.dateGetDate &&
    ownValue(pins.datePrototype, 'toISOString') === pins.dateToISOString &&
    ownGetter(pins.typedArrayPrototype, 'buffer') === pins.typedArrayBuffer &&
    ownGetter(pins.typedArrayPrototype, 'byteOffset') ===
      pins.typedArrayByteOffset &&
    ownGetter(pins.typedArrayPrototype, 'byteLength') ===
      pins.typedArrayByteLength &&
    ownGetter(pins.arrayBufferPrototype, 'byteLength') ===
      pins.arrayBufferByteLength
  );
}
