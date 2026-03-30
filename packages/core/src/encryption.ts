/**
 * Browser-compatible encryption helpers.
 *
 * Uses the Web Crypto API (`globalThis.crypto.subtle`) which works in
 * both modern browsers and Node.js 20+. This module is intentionally
 * free of Node.js-specific imports so it can be bundled for the browser.
 *
 * The World interface (`getEncryptionKeyForRun`) returns a raw 32-byte
 * per-run key. Core imports that key twice:
 * - as `AES-GCM` for legacy `encr` payloads
 * - as `HKDF` for derived-key `enc2` payloads
 *
 * Wire format for AES-GCM blobs: `[nonce (12 bytes)][ciphertext + auth tag]`
 * The `encr` / `enc2` serialization prefixes are NOT part of this module —
 * they're added/stripped by the serialization layer.
 */

// CryptoKey is a global type in browsers and Node.js 20+, but TypeScript's
// `es2022` lib doesn't include it. Re-export it from the node:crypto types
// so consumers can reference it without adding `dom` lib.
export type CryptoKey = import('node:crypto').webcrypto.CryptoKey;

const NONCE_LENGTH = 12;
const TAG_LENGTH = 128; // bits
const KEY_LENGTH = 32; // bytes (AES-256)
const HKDF_SALT = new Uint8Array(KEY_LENGTH);
const V2_HEADER_LENGTH_SIZE = 4;
const MAX_V2_HEADER_LENGTH = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EncryptionKeyBundle {
  legacyKey: CryptoKey;
  derivationKey: CryptoKey;
}

export type EncryptionKeyLike = CryptoKey | EncryptionKeyBundle;

export interface EncryptedV2Header {
  purpose: string;
  runId: string;
  activityId?: string;
  counter?: number;
}

function validateRawKey(raw: Uint8Array): void {
  if (raw.byteLength !== KEY_LENGTH) {
    throw new Error(
      `Encryption key must be exactly ${KEY_LENGTH} bytes, got ${raw.byteLength}`
    );
  }
}

export function isEncryptionKeyBundle(
  key: EncryptionKeyLike | undefined
): key is EncryptionKeyBundle {
  return (
    typeof key === 'object' &&
    key !== null &&
    'legacyKey' in key &&
    'derivationKey' in key
  );
}

export function getLegacyKey(
  key: EncryptionKeyLike | undefined
): CryptoKey | undefined {
  if (!key) return undefined;
  return isEncryptionKeyBundle(key) ? key.legacyKey : key;
}

export function getDerivationKey(
  key: EncryptionKeyLike | undefined
): CryptoKey | undefined {
  if (!isEncryptionKeyBundle(key)) return undefined;
  return key.derivationKey;
}

/**
 * Import a raw AES-256 key as a legacy `AES-GCM` `CryptoKey`.
 *
 * This is kept for backwards compatibility with callers that still
 * explicitly work with the legacy `encr` path.
 *
 * @param raw - Raw 32-byte AES-256 key (from World.getEncryptionKeyForRun)
 * @returns CryptoKey ready for AES-GCM operations
 */
export async function importLegacyKey(raw: Uint8Array) {
  validateRawKey(raw);
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Import a raw per-run key as an `HKDF` base key for derived `enc2` keys.
 *
 * @param raw - Raw 32-byte per-run key
 * @returns CryptoKey ready for HKDF deriveKey operations
 */
export async function importDerivationKey(raw: Uint8Array) {
  validateRawKey(raw);
  return globalThis.crypto.subtle.importKey('raw', raw, 'HKDF', false, [
    'deriveKey',
  ]);
}

/**
 * Import a raw per-run key into the pair of keys needed by core.
 */
export async function importEncryptionKeys(
  raw: Uint8Array
): Promise<EncryptionKeyBundle> {
  const [legacyKey, derivationKey] = await Promise.all([
    importLegacyKey(raw),
    importDerivationKey(raw),
  ]);
  return { legacyKey, derivationKey };
}

/**
 * Derive an activity-specific AES-256-GCM key from the per-run HKDF key.
 *
 * The `info` bytes should encode the full activity context. For `enc2`
 * payloads we reuse the exact serialized header bytes as both the HKDF
 * `info` parameter and the AES-GCM AAD.
 */
export async function deriveActivityKey(
  derivationKey: CryptoKey,
  info: Uint8Array
): Promise<CryptoKey> {
  const derived = await globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info,
    },
    derivationKey,
    { name: 'AES-GCM', length: KEY_LENGTH * 8 },
    false,
    ['encrypt', 'decrypt']
  );
  return derived as CryptoKey;
}

function isValidEncryptedV2Header(value: unknown): value is EncryptedV2Header {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const header = value as Record<string, unknown>;
  return (
    typeof header.purpose === 'string' &&
    header.purpose.length > 0 &&
    typeof header.runId === 'string' &&
    header.runId.length > 0 &&
    (header.activityId === undefined ||
      typeof header.activityId === 'string') &&
    (header.counter === undefined ||
      (typeof header.counter === 'number' &&
        Number.isInteger(header.counter) &&
        header.counter >= 0))
  );
}

export function encodeEncryptedV2Header(header: EncryptedV2Header): Uint8Array {
  if (!isValidEncryptedV2Header(header)) {
    throw new Error('Invalid enc2 header');
  }

  const normalized: EncryptedV2Header = {
    purpose: header.purpose,
    runId: header.runId,
  };
  if (header.activityId !== undefined) {
    normalized.activityId = header.activityId;
  }
  if (header.counter !== undefined) {
    normalized.counter = header.counter;
  }

  return encoder.encode(JSON.stringify(normalized));
}

export function decodeEncryptedV2Header(
  headerBytes: Uint8Array
): EncryptedV2Header {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(headerBytes));
  } catch (error) {
    throw new Error('Invalid enc2 header JSON', { cause: error });
  }

  if (!isValidEncryptedV2Header(parsed)) {
    throw new Error('Invalid enc2 header fields');
  }

  return parsed;
}

/**
 * Encode the inner `enc2` payload body:
 * `[4-byte header length][header bytes][nonce + ciphertext + auth tag]`
 */
export function encodeEncryptedV2Body(
  headerBytes: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  const result = new Uint8Array(
    V2_HEADER_LENGTH_SIZE + headerBytes.byteLength + ciphertext.byteLength
  );
  new DataView(result.buffer).setUint32(0, headerBytes.byteLength, false);
  result.set(headerBytes, V2_HEADER_LENGTH_SIZE);
  result.set(ciphertext, V2_HEADER_LENGTH_SIZE + headerBytes.byteLength);
  return result;
}

export function decodeEncryptedV2Body(data: Uint8Array): {
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (data.byteLength < V2_HEADER_LENGTH_SIZE) {
    throw new Error('enc2 payload too short to contain header length');
  }

  const headerLength = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getUint32(0, false);

  if (headerLength === 0 || headerLength > MAX_V2_HEADER_LENGTH) {
    throw new Error(`Invalid enc2 header length: ${headerLength}`);
  }

  const headerStart = V2_HEADER_LENGTH_SIZE;
  const headerEnd = headerStart + headerLength;
  if (data.byteLength < headerEnd) {
    throw new Error('enc2 payload truncated before header completed');
  }

  const ciphertext = data.subarray(headerEnd);
  if (ciphertext.byteLength === 0) {
    throw new Error('enc2 payload missing ciphertext');
  }

  return {
    headerBytes: data.subarray(headerStart, headerEnd),
    ciphertext,
  };
}

/**
 * Encrypt data using AES-256-GCM.
 *
 * @param key - CryptoKey from `importLegacyKey()`
 * @param data - Plaintext to encrypt
 * @param aad - Optional AES-GCM additional authenticated data
 * @returns `[nonce (12 bytes)][ciphertext + GCM auth tag]`
 */
export async function encrypt(
  key: CryptoKey,
  data: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      tagLength: TAG_LENGTH,
      ...(aad ? { additionalData: aad } : {}),
    },
    key,
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
 * @param key - CryptoKey from `importLegacyKey()`
 * @param data - `[nonce (12 bytes)][ciphertext + GCM auth tag]`
 * @param aad - Optional AES-GCM additional authenticated data
 * @returns Decrypted plaintext
 */
export async function decrypt(
  key: CryptoKey,
  data: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const minLength = NONCE_LENGTH + TAG_LENGTH / 8; // nonce + auth tag
  if (data.byteLength < minLength) {
    throw new Error(
      `Encrypted data too short: expected at least ${minLength} bytes, got ${data.byteLength}`
    );
  }
  const nonce = data.subarray(0, NONCE_LENGTH);
  const ciphertext = data.subarray(NONCE_LENGTH);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      tagLength: TAG_LENGTH,
      ...(aad ? { additionalData: aad } : {}),
    },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
}
