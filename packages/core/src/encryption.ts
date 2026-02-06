/**
 * Browser-compatible AES-256-GCM encryption module.
 *
 * Uses the Web Crypto API (`globalThis.crypto.subtle`) which works in
 * both modern browsers and Node.js 20+. This module is intentionally
 * free of Node.js-specific imports so it can be bundled for the browser.
 *
 * The World interface (`getEncryptionKeyForRun`) returns a raw 32-byte
 * AES-256 key. This module uses that key directly for AES-GCM operations.
 *
 * Wire format: `[nonce (12 bytes)][ciphertext + auth tag]`
 * The `encr` format prefix is NOT part of this module — it's added/stripped
 * by the serialization layer in `maybeEncrypt`/`maybeDecrypt`.
 */

const NONCE_LENGTH = 12;
const TAG_LENGTH = 128; // bits
const KEY_LENGTH = 32; // bytes (AES-256)

/**
 * Encrypt data using AES-256-GCM.
 *
 * @param key - Raw 32-byte AES-256 key
 * @param data - Plaintext to encrypt
 * @returns `[nonce (12 bytes)][ciphertext + GCM auth tag]`
 */
export async function encrypt(
  key: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  if (key.byteLength !== KEY_LENGTH) {
    throw new Error(
      `Encryption key must be exactly ${KEY_LENGTH} bytes, got ${key.byteLength}`
    );
  }
  const cryptoKey = await importKey(key);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH },
    cryptoKey,
    data
  );
  const result = new Uint8Array(NONCE_LENGTH + ciphertext.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertext), NONCE_LENGTH);
  return result;
}

/**
 * Decrypt data using AES-256-GCM.
 *
 * @param key - Raw 32-byte AES-256 key
 * @param data - `[nonce (12 bytes)][ciphertext + GCM auth tag]`
 * @returns Decrypted plaintext
 */
export async function decrypt(
  key: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  if (key.byteLength !== KEY_LENGTH) {
    throw new Error(
      `Encryption key must be exactly ${KEY_LENGTH} bytes, got ${key.byteLength}`
    );
  }
  const minLength = NONCE_LENGTH + TAG_LENGTH / 8; // nonce + auth tag
  if (data.byteLength < minLength) {
    throw new Error(
      `Encrypted data too short: expected at least ${minLength} bytes, got ${data.byteLength}`
    );
  }
  const cryptoKey = await importKey(key);
  const nonce = data.subarray(0, NONCE_LENGTH);
  const ciphertext = data.subarray(NONCE_LENGTH);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH },
    cryptoKey,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

/**
 * Import a raw key as a CryptoKey for AES-GCM operations.
 */
async function importKey(raw: Uint8Array) {
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
