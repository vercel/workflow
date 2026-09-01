import { Buffer } from 'node:buffer';

type EncodedUint8Array = {
  __type: 'Uint8Array';
  data: string;
};

function isEncodedUint8Array(value: unknown): value is EncodedUint8Array {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__type' in value &&
    value.__type === 'Uint8Array' &&
    'data' in value &&
    typeof value.data === 'string'
  );
}

/**
 * JSON replacer for the queue wire format. Queue messages may contain
 * serialized workflow inputs, so Uint8Array values need an explicit binary
 * envelope instead of JSON's default object-of-numeric-properties encoding.
 *
 * This module is intentionally exposed through the `queue-json` subpath. It
 * imports Node's Buffer implementation and must not enter browser bundles
 * through the package root.
 */
export function queueJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __type: 'Uint8Array',
      data: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength
      ).toString('base64'),
    } satisfies EncodedUint8Array;
  }
  return value;
}

/** Restores values written by {@link queueJsonReplacer}. */
export function queueJsonReviver(_key: string, value: unknown): unknown {
  if (!isEncodedUint8Array(value)) return value;
  return new Uint8Array(Buffer.from(value.data, 'base64'));
}

/** Serializes a queue message to the stable JSON wire format. */
export function serializeQueueMessage(message: unknown): Buffer {
  return Buffer.from(JSON.stringify(message, queueJsonReplacer));
}

/** Deserializes a queue message from the stable JSON wire format. */
export function deserializeQueueMessage(data: Uint8Array): unknown {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return JSON.parse(buffer.toString(), queueJsonReviver);
}
