/**
 * Workflow mode serialization.
 *
 * Provides serialize/deserialize for use inside the workflow execution
 * environment (QuickJS VM or Node.js vm). It is:
 * - Synchronous (no async operations)
 * - No encryption (encryption is handled outside the VM on the host side)
 *
 * Designed to be bundled into the workflow code by esbuild and executed
 * inside the sandboxed VM.
 */

import { WorkflowRuntimeError } from '@workflow/errors';
import type { CodecOptions } from './codec.js';
import { devalueCodec } from './codec-devalue.js';
import { formatSerializationError } from './errors.js';
import { decodeFormatPrefix, encodeWithFormatPrefix } from './format.js';
import { SerializationFormat } from './types.js';

/**
 * Serialize a value for storage/transmission from the workflow environment.
 *
 * @param value - The value to serialize
 * @param options - Optional global, extra reducers/revivers for VM-context serialization
 * @returns Format-prefixed serialized bytes
 */
export function serialize(value: unknown, options?: CodecOptions): Uint8Array {
  try {
    const payload = devalueCodec.serialize(value, 'workflow', options);
    return encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError('workflow value', error),
      { slug: 'serialization-failed', cause: error }
    );
  }
}

/**
 * Deserialize a value received in the workflow environment.
 *
 * @param data - Format-prefixed serialized bytes, or legacy data
 * @param options - Optional global, extra revivers for VM-context deserialization
 * @returns The deserialized value
 */
export function deserialize(
  data: Uint8Array | unknown,
  options?: CodecOptions
): unknown {
  if (!(data instanceof Uint8Array)) {
    if (devalueCodec.deserializeLegacy) {
      return devalueCodec.deserializeLegacy(data, 'workflow', options);
    }
    throw new Error(
      'Cannot deserialize non-binary data without legacy support'
    );
  }

  const { format, payload } = decodeFormatPrefix(data);

  if (format === SerializationFormat.DEVALUE_V1) {
    return devalueCodec.deserialize(payload, 'workflow', options);
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}
