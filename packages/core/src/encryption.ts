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
 * Wire format: `[nonce (12 bytes)][ciphertext + auth tag]`. The serialization
 * encryption module owns the outer `encr` format prefix.
 */

// CryptoKey is a global type in browsers and Node.js 20+, but TypeScript's
// `es2022` lib doesn't include it. Re-export it from the node:crypto types
// so consumers can reference it without adding `dom` lib.
export type CryptoKey = import('node:crypto').webcrypto.CryptoKey;

/**
 * Node key handles retained alongside keys imported by this module.
 *
 * Node's synchronous cipher API needs a native key handle. Creating it while
 * the raw bytes are already available avoids trying to convert a deliberately
 * non-extractable `CryptoKey` later. Passing the `CryptoKey` directly to
 * `createDecipheriv`, or converting it later with `KeyObject.from`, is
 * deprecated by Node for non-extractable keys. Browser/edge callers never
 * populate or consult this map.
 */
const nodeKeys = new WeakMap<CryptoKey, import('node:crypto').KeyObject>();

/** Resolve node:crypto without a static import, preserving browser bundles. */
const nodeCrypto = (() => {
  try {
    return typeof process === 'undefined'
      ? undefined
      : process.getBuiltinModule('node:crypto');
  } catch {
    return undefined;
  }
})();

/** AES-GCM nonce length in bytes. */
export const NONCE_LENGTH = 12;
/** AES-GCM authentication tag length in bits. */
export const TAG_LENGTH = 128;
/** AES-GCM authentication tag length in bytes. */
export const TAG_BYTES = TAG_LENGTH / 8;
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
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    raw,
    'AES-GCM',
    false,
    // `KeyUsage` is a DOM-lib type that's not in scope under `es2022`.
    // The `ReadonlyArray<'encrypt' | 'decrypt'>` parameter type matches
    // a strict subset of `KeyUsage[]`, so this cast is sound.
    usages as ('encrypt' | 'decrypt')[]
  );
  if (nodeCrypto) {
    nodeKeys.set(key, nodeCrypto.createSecretKey(raw));
  }
  return key;
}

function assertValidAesGcmEnvelope(data: Uint8Array): void {
  const minLength = NONCE_LENGTH + TAG_BYTES;
  if (data.byteLength < minLength) {
    throw new RuntimeDecryptionError(
      `Encrypted data too short: expected at least ${minLength} bytes, got ${data.byteLength}`,
      {
        context: { operation: 'decrypt', byteLength: data.byteLength },
      }
    );
  }
}

function wrapDecryptionError(cause: unknown, byteLength: number): never {
  throw new RuntimeDecryptionError(
    `AES-256-GCM decryption failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    {
      cause,
      context: { operation: 'decrypt', byteLength },
    }
  );
}

/**
 * Decrypt AES-256-GCM synchronously when running on Node and the key was
 * imported by this module.
 *
 * The key must have been created by this module's {@link importKey}, and the
 * Node synchronous crypto API must be available. Authentication failures throw
 * the same RuntimeDecryptionError shape as {@link decrypt}.
 */
export function decryptSync(
  key: CryptoKey,
  data: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  const nodeKey = nodeKeys.get(key);
  if (!nodeKey) {
    throw new WorkflowRuntimeError(
      'Synchronous AES-256-GCM decryption requires a key created by importKey()'
    );
  }
  if (!nodeCrypto) {
    throw new WorkflowRuntimeError(
      'Synchronous AES-256-GCM decryption requires the Node.js crypto module'
    );
  }
  if (!key.usages.includes('decrypt')) {
    throw new RuntimeDecryptionError(
      'AES-256-GCM decryption failed: CryptoKey does not support decrypt',
      {
        context: { operation: 'decrypt', byteLength: data.byteLength },
      }
    );
  }

  assertValidAesGcmEnvelope(data);
  const ciphertextEnd = data.byteLength - TAG_BYTES;
  const nonce = data.subarray(0, NONCE_LENGTH);
  const ciphertext = data.subarray(NONCE_LENGTH, ciphertextEnd);
  const authTag = data.subarray(ciphertextEnd);
  try {
    const decipher = nodeCrypto.createDecipheriv(
      'aes-256-gcm',
      nodeKey,
      nonce,
      { authTagLength: TAG_BYTES }
    );
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const head = decipher.update(ciphertext);
    const tail = decipher.final();
    if (tail.byteLength === 0) {
      return new Uint8Array(head.buffer, head.byteOffset, head.byteLength);
    }
    const plaintext = new Uint8Array(head.byteLength + tail.byteLength);
    plaintext.set(head, 0);
    plaintext.set(tail, head.byteLength);
    return plaintext;
  } catch (cause) {
    wrapDecryptionError(cause, data.byteLength);
  }
}

/**
 * Encrypt data using AES-256-GCM.
 *
 * @param key - CryptoKey from `importKey()`
 * @param data - Plaintext to encrypt
 * @param aad - Optional additional authenticated data. Not encrypted, but
 *   covered by the GCM auth tag: decryption fails unless the exact same
 *   bytes are supplied. Used by the sealed-box layer to bind ciphertext to
 *   a `projectId|runId` context. Omit for no AAD (the legacy behavior).
 * @returns `[nonce (12 bytes)][ciphertext + GCM auth tag]`
 */
export async function encrypt(
  key: CryptoKey,
  data: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        tagLength: TAG_LENGTH,
        ...(aad ? { additionalData: aad } : {}),
      },
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
 * @param aad - Optional additional authenticated data. Must match the bytes
 *   passed to {@link encrypt} exactly, otherwise the GCM tag fails to verify
 *   and a {@link RuntimeDecryptionError} is thrown.
 * @returns Decrypted plaintext
 */
export async function decrypt(
  key: CryptoKey,
  data: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  assertValidAesGcmEnvelope(data);
  const nonce = data.subarray(0, NONCE_LENGTH);
  const ciphertextAndTag = data.subarray(NONCE_LENGTH);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        tagLength: TAG_LENGTH,
        ...(aad ? { additionalData: aad } : {}),
      },
      key,
      ciphertextAndTag
    );
  } catch (cause) {
    wrapDecryptionError(cause, data.byteLength);
  }
  return new Uint8Array(plaintext);
}
