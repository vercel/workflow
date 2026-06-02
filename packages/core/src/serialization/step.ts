/**
 * Step mode serialization.
 *
 * Used by the step handler for serializing step return values and
 * deserializing step arguments. Supports encryption as a composable layer.
 */

import { SerializationError } from '@workflow/errors';
import type { CodecOptions } from './codec.js';
import { devalueCodec } from './codec-devalue.js';
import {
  type CryptoKey,
  decrypt as decryptData,
  encrypt as encryptData,
} from './encryption.js';
import { formatSerializationError, rethrowIfRuntimeError } from './errors.js';
import { decodeFormatPrefix, encodeWithFormatPrefix } from './format.js';
import { SerializationFormat } from './types.js';

/**
 * Serialize a value from the step execution environment.
 */
export async function serialize(
  value: unknown,
  encryptionKey?: CryptoKey,
  options?: CodecOptions
): Promise<Uint8Array | unknown> {
  try {
    const payload = devalueCodec.serialize(value, 'step', options);
    const prefixed = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
    return encryptData(prefixed, encryptionKey);
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
  data: Uint8Array | unknown,
  encryptionKey?: CryptoKey,
  options?: CodecOptions
): Promise<unknown> {
  const decrypted = await decryptData(data, encryptionKey);

  if (!(decrypted instanceof Uint8Array)) {
    if (devalueCodec.deserializeLegacy) {
      return devalueCodec.deserializeLegacy(decrypted, 'step', options);
    }
    throw new Error(
      'Cannot deserialize non-binary data without legacy support'
    );
  }

  const { format, payload } = decodeFormatPrefix(decrypted);

  if (format === SerializationFormat.DEVALUE_V1) {
    return devalueCodec.deserialize(payload, 'step', options);
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}
