/**
 * Step mode serialization.
 *
 * Used by the step executor for serializing step return values and
 * deserializing step arguments. Supports encryption as a composable layer.
 */

import { FatalError, SerializationError } from '@workflow/errors';
import type { CodecOptions } from './codec.js';
import { devalueCodec } from './codec-devalue.js';
import { compress, decompress } from './compression.js';
import {
  decrypt as decryptData,
  encrypt as encryptData,
  type PayloadKey,
} from './encryption.js';
import { formatSerializationError, rethrowIfRuntimeError } from './errors.js';
import {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  peekFormatPrefix,
} from './format.js';
import { StateContext, WorkflowStateMissingError } from './state-refs.js';
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
    // Compress before encrypting, since encrypted bytes don't compress.
    const compressed = await compress(
      prefixed,
      options?.compression ?? false,
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

  // Rebuild the run's state only when this input refers to records a fresh
  // context lacks, not whenever it holds a state record.
  if (
    options?.recoverStateContext &&
    !options.stateContext &&
    decrypted instanceof Uint8Array &&
    peekFormatPrefix(decrypted) === SerializationFormat.DEVALUE_V1 &&
    new StateContext().needsRecovery(decodeFormatPrefix(decrypted).payload)
  ) {
    options.stateContext = await options.recoverStateContext(decrypted);
  }

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
    try {
      return devalueCodec.deserialize(payload, 'step', options);
    } catch (error) {
      // The log lacks what the writer saw: every retry would fail the same way.
      if (error instanceof WorkflowStateMissingError)
        throw Object.assign(
          new FatalError(
            `Cannot read the frozen state in this step's input: ${error.message}`
          ),
          { cause: error }
        );
      throw error;
    }
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}
