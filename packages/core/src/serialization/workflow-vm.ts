/**
 * VM-compatible workflow mode serialization.
 *
 * This module is designed to be bundled into the QuickJS WASM VM.
 * It has NO Node.js dependencies (no Buffer, no node:util).
 *
 * Produces and consumes the same wire format as the Node.js workflow.ts —
 * format-prefixed devalue data ("devl" + devalue.stringify output).
 */

import { devalueVmCodec } from './codec-devalue-vm.js';
import { SerializationFormat, isFormatPrefix } from './types.js';

const FORMAT_PREFIX_LENGTH = 4;
let _encoder: { encode(s: string): Uint8Array };
let _decoder: { decode(d: Uint8Array): string };
function getEncoder() {
  if (!_encoder) _encoder = new (globalThis as any).TextEncoder();
  return _encoder;
}
function getDecoder() {
  if (!_decoder) _decoder = new (globalThis as any).TextDecoder();
  return _decoder;
}

/**
 * Serialize a value to format-prefixed bytes.
 *
 * @param value - The value to serialize
 * @returns Uint8Array with "devl" prefix + devalue payload
 */
export function serialize(value: unknown): Uint8Array {
  const payload = devalueVmCodec.serialize(value, 'workflow');
  const prefix = getEncoder().encode(SerializationFormat.DEVALUE_V1);
  const result = new Uint8Array(prefix.length + payload.length);
  result.set(prefix, 0);
  result.set(payload, prefix.length);
  return result;
}

/**
 * Deserialize format-prefixed bytes back to a value.
 *
 * @param data - Uint8Array with format prefix, or legacy non-binary data
 * @returns The deserialized value
 */
export function deserialize(data: Uint8Array | unknown): unknown {
  // Legacy: non-binary data
  if (!(data instanceof Uint8Array)) {
    if (devalueVmCodec.deserializeLegacy) {
      return devalueVmCodec.deserializeLegacy(data, 'workflow');
    }
    throw new Error(
      'Cannot deserialize non-binary data without legacy support'
    );
  }

  if (data.length < FORMAT_PREFIX_LENGTH) {
    throw new Error('Data too short to contain format prefix');
  }

  const prefixStr = getDecoder().decode(data.subarray(0, FORMAT_PREFIX_LENGTH));
  if (!isFormatPrefix(prefixStr)) {
    throw new Error(`Invalid format prefix: "${prefixStr}"`);
  }

  if (prefixStr === SerializationFormat.DEVALUE_V1) {
    const payload = data.subarray(FORMAT_PREFIX_LENGTH);
    return devalueVmCodec.deserialize(payload, 'workflow');
  }

  throw new Error(`Unsupported serialization format: ${prefixStr}`);
}
