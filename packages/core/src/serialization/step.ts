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
  decrypt as decryptData,
  encrypt as encryptData,
  type PayloadKey,
} from './encryption.js';
import { formatSerializationError, rethrowIfRuntimeError } from './errors.js';
import { decodeFormatPrefix, encodeWithFormatPrefix } from './format.js';
import { splitChainEnvelope } from './chain-envelope.js';
import { SerializationFormat } from './types.js';

/**
 * Serialize a value from the step execution environment.
 */
export async function serialize(
  value: unknown,
  encryptionKey?: PayloadKey,
  options?: CodecOptions
): Promise<Uint8Array | unknown> {
  try {
    const payload = devalueCodec.serialize(value, 'step', options);
    const prefixed = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
    const plaintext = options?.wrapPlaintext?.(prefixed) ?? prefixed;
    // Compress before encrypting, since encrypted bytes don't compress.
    const compressed = await compress(
      plaintext,
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
  data: Uint8Array | unknown,
  encryptionKey?: PayloadKey,
  options?: CodecOptions
): Promise<unknown> {
  const decrypted = await decompress(
    await decryptData(data, encryptionKey),
    options?.compressionStats
  );

  const nested =
    decrypted instanceof Uint8Array
      ? splitChainEnvelope(decrypted).payload
      : decrypted;

  if (!(nested instanceof Uint8Array)) {
    if (devalueCodec.deserializeLegacy) {
      return devalueCodec.deserializeLegacy(nested, 'step', options);
    }
    throw new Error(
      'Cannot deserialize non-binary data without legacy support'
    );
  }

  const { format, payload } = decodeFormatPrefix(nested);

  if (format === SerializationFormat.DEVALUE_V1) {
    return devalueCodec.deserialize(payload, 'step', options);
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}
