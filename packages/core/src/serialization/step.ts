/**
 * Step mode serialization.
 *
 * Used by the step executor for serializing step return values and
 * deserializing step arguments. Supports encryption as a composable layer.
 */

import { SerializationError } from '@workflow/errors';
import type { CodecOptions } from './codec.js';
import { devalueCodec } from './codec-devalue.js';
import { compress, decompress } from './compression.js';
import {
  type DecryptionKey,
  decrypt as decryptData,
  encrypt as encryptData,
  type PayloadKey,
} from './encryption.js';
import { formatSerializationError, rethrowIfRuntimeError } from './errors.js';
import { decodeFormatPrefix, encodeWithFormatPrefix } from './format.js';
import { SerializationFormat } from './types.js';

/**
 * Serialize a value from the step execution environment.
 */
export async function serialize(
  value: unknown,
  encryptionKey?: PayloadKey,
  options?: CodecOptions
): Promise<Uint8Array> {
  try {
    const payload = devalueCodec.serialize(value, 'step', options);
    const prefixed = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    );
    // Compress before encrypting — encrypted bytes don't compress.
    const compressed = await compress(
      prefixed,
      options?.compression === true,
      options?.compressionStats
    );
    return encryptData(compressed, encryptionKey);
  } catch (error) {
    rethrowIfRuntimeError(error);
    const { message, hint } = formatSerializationError('step value', error);
    throw new SerializationError(message, { hint, cause: error });
  }
}

/**
 * Deserialize a value for the step execution environment.
 */
export async function deserialize(
  data: unknown,
  encryptionKey?: DecryptionKey,
  options?: CodecOptions
): Promise<unknown> {
  if (!(data instanceof Uint8Array)) {
    if (devalueCodec.deserializeLegacy) {
      return devalueCodec.deserializeLegacy(data, 'step', options);
    }
    throw new Error(
      'Cannot deserialize non-binary data without legacy support'
    );
  }

  const decrypted = await decryptData(data, encryptionKey);
  const prepared = await decompress(decrypted, options?.compressionStats);
  const { format, payload } = decodeFormatPrefix(prepared);

  if (format === SerializationFormat.DEVALUE_V1) {
    return devalueCodec.deserialize(payload, 'step', options);
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}
