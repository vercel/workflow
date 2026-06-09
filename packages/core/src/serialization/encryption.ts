/**
 * Composable encryption layer for serialized data.
 *
 * Wraps/unwraps serialized payloads with AES-256-GCM encryption,
 * using the format prefix system to mark encrypted data.
 */

import { RuntimeDecryptionError } from '@workflow/errors';
import {
  decrypt as aesGcmDecrypt,
  encrypt as aesGcmEncrypt,
  type CryptoKey,
} from '../encryption.js';
import {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  peekFormatPrefix,
} from './format.js';
import { SerializationFormat } from './types.js';

export type { CryptoKey };

/**
 * Encryption key parameter type. Accepts a resolved key, undefined (no encryption),
 * a promise, or a resolver that can defer fetching the key until data needs it.
 */
export type EncryptionKeyParam =
  | CryptoKey
  | undefined
  | Promise<CryptoKey | undefined>
  | (() => Promise<CryptoKey | undefined>);

export async function resolveEncryptionKey(
  key: EncryptionKeyParam
): Promise<CryptoKey | undefined> {
  return typeof key === 'function' ? key() : key;
}

/**
 * Encrypt a format-prefixed payload if a key is provided.
 * Wraps the data with the 'encr' format prefix.
 *
 * @param data - The format-prefixed serialized data
 * @param key - Encryption key (undefined to skip encryption)
 * @returns The encrypted data with 'encr' prefix, or the original data if no key
 */
export async function encrypt(
  data: Uint8Array | unknown,
  key: CryptoKey | undefined
): Promise<Uint8Array | unknown> {
  if (!key || !(data instanceof Uint8Array)) return data;
  const encrypted = await aesGcmEncrypt(key, data);
  return encodeWithFormatPrefix(SerializationFormat.ENCRYPTED, encrypted);
}

/**
 * Decrypt a format-prefixed payload if it's encrypted.
 * Strips the 'encr' format prefix and decrypts the inner payload.
 *
 * @param data - The potentially encrypted data
 * @param key - Encryption key (undefined to skip decryption)
 * @returns The decrypted inner payload, or the original data if not encrypted
 */
export async function decrypt(
  data: Uint8Array | unknown,
  key: CryptoKey | undefined
): Promise<Uint8Array | unknown> {
  // Non-binary data is returned as-is.
  if (!(data instanceof Uint8Array)) return data;

  const format = peekFormatPrefix(data);

  // If the data is encrypted but no key was provided, fail fast.
  if (format === SerializationFormat.ENCRYPTED && !key) {
    throw new RuntimeDecryptionError(
      'Encrypted data encountered but no encryption key is available. ' +
        'Encryption is not configured or no key was provided for this run.',
      {
        context: {
          operation: 'decrypt',
          byteLength: data.byteLength,
          formatPrefix: 'encr',
        },
      }
    );
  }

  // If the data is not encrypted, return it unchanged.
  if (format !== SerializationFormat.ENCRYPTED) return data;

  const { payload } = decodeFormatPrefix(data);
  try {
    return await aesGcmDecrypt(key!, payload);
  } catch (error) {
    // The low-level AES layer only sees the stripped payload, so it cannot
    // record the outer envelope prefix. This layer peeked it (`encr`), so
    // enrich the diagnostic context with the real format prefix before
    // rethrowing.
    if (RuntimeDecryptionError.is(error) && error.context) {
      error.context.formatPrefix = format;
    }
    throw error;
  }
}
