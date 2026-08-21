/**
 * Client (external) mode serialization.
 *
 * Used when starting workflows from the client side (serializing workflow
 * arguments) and when receiving workflow return values. Supports encryption.
 */

import { SerializationError } from '@workflow/errors';
import type { CodecOptions } from './codec.js';
import { devalueCodec } from './codec-devalue.js';
import type { DecryptionKey, PayloadKey } from './encryption.js';
import { formatSerializationError, rethrowIfRuntimeError } from './errors.js';
import { decodeFormatPrefix, encodeWithFormatPrefix } from './format.js';
import { decodePayload, encodePayload } from './payload.js';
import { SerializationFormat } from './types.js';

/**
 * Serialize a value from the client environment (e.g. workflow arguments).
 */
export async function serialize(
  value: unknown,
  encryptionKey?: PayloadKey,
  options?: CodecOptions
): Promise<Uint8Array> {
  try {
    const payload = devalueCodec.serialize(value, 'client', options);
    const prefixed = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    );
    return await encodePayload(
      prefixed,
      encryptionKey,
      options?.compression ?? false,
      options?.compressionStats
    );
  } catch (error) {
    rethrowIfRuntimeError(error);
    const { message, hint } = formatSerializationError('client value', error);
    throw new SerializationError(message, { hint, cause: error });
  }
}

/**
 * Deserialize a value for the client environment (e.g. workflow return value).
 */
export async function deserialize(
  data: unknown,
  encryptionKey?: DecryptionKey,
  options?: CodecOptions
): Promise<unknown> {
  if (!(data instanceof Uint8Array)) {
    if (devalueCodec.deserializeLegacy) {
      return devalueCodec.deserializeLegacy(data, 'client', options);
    }
    throw new Error(
      'Cannot deserialize non-binary data without legacy support'
    );
  }

  const prepared = await decodePayload(
    data,
    encryptionKey,
    options?.compressionStats
  );
  const { format, payload } = decodeFormatPrefix(prepared);

  if (format === SerializationFormat.DEVALUE_V1) {
    return devalueCodec.deserialize(payload, 'client', options);
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}
