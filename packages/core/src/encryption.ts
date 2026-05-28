import { RuntimeDecryptionError, WorkflowRuntimeError } from '@workflow/errors';

/**
 * Browser-compatible AES-256-GCM encryption module.
 *
 * Uses the Web Crypto API (`globalThis.crypto.subtle`) which works in
 * both modern browsers and Node.js 20+. This module is intentionally
 * free of Node.js-specific imports so it can be bundled for the browser.
 *
 * The World interface (`getEncryptionKeyForRun`) returns a raw 32-byte
 * AES-256 key. Callers should use `importKey()` once to convert it to a
 * `CryptoKey`, then pass that to `encrypt()`/`decrypt()` for all
 * operations within the same run. This avoids repeated `importKey()`
 * calls on every encrypt/decrypt invocation.
 *
 * Wire format: `[nonce (12 bytes)][ciphertext + auth tag]`
 * The `encr` format prefix is NOT part of this module — it's added/stripped
 * by the serialization layer in `maybeEncrypt`/`maybeDecrypt`.
 */

// CryptoKey is a global type in browsers and Node.js 20+, but TypeScript's
// `es2022` lib doesn't include it. Re-export it from the node:crypto types
// so consumers can reference it without adding `dom` lib.
export type CryptoKey = import('node:crypto').webcrypto.CryptoKey;

const NONCE_LENGTH = 12;
const TAG_LENGTH = 128; // bits
const KEY_LENGTH = 32; // bytes (AES-256)

/**
 * Import a raw AES-256 key as a `CryptoKey` for use with `encrypt()`/`decrypt()`.
 *
 * Callers should call this once per run (after `getEncryptionKeyForRun()`)
 * and pass the resulting `CryptoKey` to all subsequent encrypt/decrypt calls.
 *
 * Pass `usages: ['encrypt']` (or `['decrypt']`) for cross-run scenarios
 * where the caller should not be able to perform the inverse operation
 * with the key — for example a child workflow writing into a parent
 * run's forwarded WritableStream only needs to encrypt, never decrypt.
 *
 * @param raw - Raw 32-byte AES-256 key (from World.getEncryptionKeyForRun)
 * @param usages - Key usages. Defaults to `['encrypt', 'decrypt']`.
 * @returns CryptoKey ready for AES-GCM operations
 */
export async function importKey(
  raw: Uint8Array,
  usages: ReadonlyArray<'encrypt' | 'decrypt'> = ['encrypt', 'decrypt']
) {
  if (raw.byteLength !== KEY_LENGTH) {
    throw new WorkflowRuntimeError(
      `Encryption key must be exactly ${KEY_LENGTH} bytes, got ${raw.byteLength}`
    );
  }
  return globalThis.crypto.subtle.importKey(
    'raw',
    raw,
    'AES-GCM',
    false,
    // `KeyUsage` is a DOM-lib type that's not in scope under `es2022`.
    // The `ReadonlyArray<'encrypt' | 'decrypt'>` parameter type matches
    // a strict subset of `KeyUsage[]`, so this cast is sound.
    usages as ('encrypt' | 'decrypt')[]
  );
}

/**
 * Encrypt data using AES-256-GCM.
 *
 * @param key - CryptoKey from `importKey()`
 * @param data - Plaintext to encrypt
 * @returns `[nonce (12 bytes)][ciphertext + GCM auth tag]`
 */
export async function encrypt(
  key: CryptoKey,
  data: Uint8Array
): Promise<Uint8Array> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH },
      key,
      data
    );
  } catch (cause) {
    // Re-wrap any Web Crypto failure (DOMException etc.) as a
    // RuntimeDecryptionError. Failures here are rare — they happen e.g.
    // when a CryptoKey was imported with `usages: ['decrypt']` only.
    throw new RuntimeDecryptionError(
      `AES-256-GCM encryption failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        context: {
          operation: 'encrypt',
          byteLength: data.byteLength,
        },
      }
    );
  }
  const result = new Uint8Array(NONCE_LENGTH + ciphertext.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertext), NONCE_LENGTH);
  return result;
}

/**
 * Decrypt data using AES-256-GCM.
 *
 * Any failure inside the Web Crypto layer — most commonly an
 * `OperationError: The operation failed for an operation-specific reason`
 * raised by `AESCipherJob.onDone` when the GCM authentication tag does
 * not verify — is rewrapped as {@link RuntimeDecryptionError}. The
 * wrapped error carries the original DOMException as `cause`, plus a
 * small diagnostic context (`operation`, input `byteLength`) to help
 * disambiguate ciphertext corruption from key mismatch from truncated
 * transport reads.
 *
 * Note: `data` is the raw AES payload (`[nonce][ciphertext + tag]`), not a
 * format-prefixed envelope — callers strip the `encr` marker via
 * `decodeFormatPrefix()` before reaching this function. The outer
 * envelope's format prefix is therefore attached by the serialization
 * layer (`serialization/encryption.ts`), which is the layer that has it.
 *
 * @param key - CryptoKey from `importKey()`
 * @param data - `[nonce (12 bytes)][ciphertext + GCM auth tag]`
 * @returns Decrypted plaintext
 */
export async function decrypt(
  key: CryptoKey,
  data: Uint8Array
): Promise<Uint8Array> {
  const minLength = NONCE_LENGTH + TAG_LENGTH / 8; // nonce + auth tag
  if (data.byteLength < minLength) {
    throw new RuntimeDecryptionError(
      `Encrypted data too short: expected at least ${minLength} bytes, got ${data.byteLength}`,
      {
        context: {
          operation: 'decrypt',
          byteLength: data.byteLength,
        },
      }
    );
  }
  const nonce = data.subarray(0, NONCE_LENGTH);
  const ciphertext = data.subarray(NONCE_LENGTH);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH },
      key,
      ciphertext
    );
  } catch (cause) {
    // The most common shape we see in the wild is a DOMException with
    // `name: 'OperationError'` and message "The operation failed for
    // an operation-specific reason" — this is what Web Crypto throws
    // when the GCM auth tag does not verify. Re-throw as
    // RuntimeDecryptionError, attaching diagnostic context (byte length)
    // that the bare DOMException lacks.
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    throw new RuntimeDecryptionError(
      `AES-256-GCM decryption failed: ${causeMsg}`,
      {
        cause,
        context: {
          operation: 'decrypt',
          byteLength: data.byteLength,
        },
      }
    );
  }
  return new Uint8Array(plaintext);
}
