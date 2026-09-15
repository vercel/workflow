/**
 * Host-side reference implementation of the QuickJS engine's workflow-mode
 * wire codec.
 *
 * The QuickJS engine serializes through handles on the host
 * (runtime/quickjs-serde.ts); this module is the value-space equivalent of
 * that codec and is used by tests to build wire fixtures and assert
 * byte-level parity. It has NO Node.js dependencies (no Buffer, no
 * node:util), which is also what made it bundleable into the VM before the
 * serde moved host-side.
 *
 * Produces and consumes the same wire format as the Node.js workflow.ts:
 * format-prefixed devalue data ("devl" + devalue.stringify output).
 */

import { globalSingleton } from '@workflow/utils';
import { devalueVmCodec } from './codec-devalue-vm.js';
import { isFormatPrefix, SerializationFormat } from './types.js';

const FORMAT_PREFIX_LENGTH = 4;
// On `globalThis` (see `globalSingleton`) so one process builds one pair,
// rather than one per bundler layer this module is compiled into.
const codecs = globalSingleton('@workflow/core//vmTextCodecs', 1, () => ({
  encoder: undefined as { encode(s: string): Uint8Array } | undefined,
  decoder: undefined as { decode(d: Uint8Array): string } | undefined,
}));
function getEncoder(): { encode(s: string): Uint8Array } {
  codecs.encoder ??= new (globalThis as any).TextEncoder();
  return codecs.encoder as { encode(s: string): Uint8Array };
}
function getDecoder(): { decode(d: Uint8Array): string } {
  codecs.decoder ??= new (globalThis as any).TextDecoder();
  return codecs.decoder as { decode(d: Uint8Array): string };
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
