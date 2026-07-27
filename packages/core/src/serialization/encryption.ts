/**
 * Composable encryption layer for serialized data.
 *
 * Wraps/unwraps serialized payloads with either symmetric AES-256-GCM
 * encryption (`encr`) or an asymmetric sealed box (`encp`), using the format
 * prefix system to mark which. See {@link PayloadKey} for how a caller
 * declares which capabilities it holds.
 */

import { RuntimeDecryptionError } from '@workflow/errors';
import {
  decrypt as aesGcmDecrypt,
  encrypt as aesGcmEncrypt,
  type CryptoKey,
} from '../encryption.js';
import {
  open as openSealed,
  type RunKeyPair,
  seal as sealToPublicKey,
} from '../sealed-box.js';
import {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  peekFormatPrefix,
} from './format.js';
import { SerializationFormat } from './types.js';

export type { CryptoKey, RunKeyPair };

/**
 * Brands distinguishing the structured key variants from a bare `CryptoKey`.
 *
 * `Symbol.for` rather than `Symbol()` because these values cross realm
 * boundaries (host ↔ workflow VM), and the global symbol registry is shared
 * across realms while unique symbols are not.
 */
const SEAL_TARGET_BRAND = Symbol.for('workflow.serialization.sealTarget');
const RUN_KEYS_BRAND = Symbol.for('workflow.serialization.runKeys');

/**
 * A write-only capability: seal payloads to a run's X25519 public key.
 *
 * This is what a *cross-run* writer holds — a hook resumption targeting
 * another run, or a child workflow writing into a parent's forwarded stream.
 * It carries no ability to decrypt anything, and because it is a distinct
 * nominal type it cannot be mistaken for symmetric key material.
 *
 * That last property matters more than it looks: a raw 32-byte X25519 public
 * key is a *structurally valid* AES-256 key, so handing one to
 * `importKey(..., 'AES-GCM')` succeeds and silently produces ciphertext that
 * nobody can ever open. Routing public keys exclusively through
 * {@link sealTo} makes that mistake unrepresentable rather than merely
 * discouraged.
 */
export interface SealTarget {
  readonly [SEAL_TARGET_BRAND]: true;
  /** The recipient run's raw 32-byte X25519 public key. */
  readonly recipientPublicKey: Uint8Array;
  /** Additional authenticated data binding the payload to the recipient run. */
  readonly aad?: Uint8Array;
}

/**
 * The full key capability of a run's *own* runtime (and of o11y tooling
 * acting on its behalf): the symmetric key for its own payloads, plus the
 * keypair needed to open sealed payloads that other runs wrote to it.
 */
export interface RunPayloadKeys {
  readonly [RUN_KEYS_BRAND]: true;
  /** Symmetric AES-256-GCM key — the run's own `encr` payloads. */
  readonly aes: CryptoKey;
  /** X25519 keypair — opens `encp` payloads sealed to this run. */
  readonly keyPair: RunKeyPair;
  /** Additional authenticated data expected on sealed payloads. */
  readonly aad?: Uint8Array;
}

/**
 * A resolved key for reading or writing a serialized payload.
 *
 * The bare `CryptoKey` variant is the historical shape and remains valid: it
 * means "symmetric only", which is exactly right for a run that predates
 * sealed boxes or for any same-run payload. The structured variants are
 * additive:
 *
 * | Variant            | Writes  | Reads          | Held by                  |
 * | ------------------ | ------- | -------------- | ------------------------ |
 * | `CryptoKey`        | `encr`  | `encr`         | same-run (legacy shape)  |
 * | {@link RunPayloadKeys} | `encr`  | `encr`, `encp` | the owning run, o11y     |
 * | {@link SealTarget} | `encp`  | —              | cross-run writers        |
 *
 * A run's own payloads deliberately stay symmetric even when the writer could
 * seal: sealing costs a fresh ECDH per envelope and 32 extra bytes, and buys
 * nothing when the writer already holds the decryption key.
 */
export type PayloadKey = CryptoKey | SealTarget | RunPayloadKeys;

/**
 * Build a write-only seal capability for a recipient run's public key.
 *
 * @param recipientPublicKey - The recipient run's raw 32-byte X25519 public key
 * @param aad - Additional authenticated data, conventionally `runAad(projectId, runId)`
 */
export function sealTo(
  recipientPublicKey: Uint8Array,
  aad?: Uint8Array
): SealTarget {
  return { [SEAL_TARGET_BRAND]: true, recipientPublicKey, aad };
}

/**
 * Bundle a run's symmetric key with the keypair that opens payloads sealed
 * to it.
 */
export function runPayloadKeys(
  aes: CryptoKey,
  keyPair: RunKeyPair,
  aad?: Uint8Array
): RunPayloadKeys {
  return { [RUN_KEYS_BRAND]: true, aes, keyPair, aad };
}

export function isSealTarget(value: unknown): value is SealTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<SealTarget>)[SEAL_TARGET_BRAND] === true
  );
}

export function isRunPayloadKeys(value: unknown): value is RunPayloadKeys {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<RunPayloadKeys>)[RUN_KEYS_BRAND] === true
  );
}

/**
 * The symmetric key to use for `encr` operations, or undefined when this key
 * has no symmetric capability (i.e. it is a seal-only target).
 */
export function aesKeyOf(key: PayloadKey | undefined): CryptoKey | undefined {
  if (!key) return undefined;
  if (isRunPayloadKeys(key)) return key.aes;
  if (isSealTarget(key)) return undefined;
  return key;
}

/**
 * Encryption key parameter type. Accepts a resolved key, undefined (no encryption),
 * a promise, or a resolver that can defer fetching the key until data needs it.
 */
export type EncryptionKeyParam =
  | PayloadKey
  | undefined
  | Promise<PayloadKey | undefined>
  | (() => Promise<PayloadKey | undefined>);

export async function resolveEncryptionKey(
  key: EncryptionKeyParam
): Promise<PayloadKey | undefined> {
  return typeof key === 'function' ? key() : key;
}

/**
 * Encrypt a format-prefixed payload if a key is provided.
 *
 * Wraps the data with the `encr` prefix for symmetric keys, or the `encp`
 * prefix when handed a {@link SealTarget} — a cross-run writer that holds only
 * the recipient's public key.
 *
 * @param data - The format-prefixed serialized data
 * @param key - Encryption key (undefined to skip encryption)
 * @returns The encrypted data with its format prefix, or the original data if no key
 */
export async function encrypt(
  data: Uint8Array | unknown,
  key: PayloadKey | undefined
): Promise<Uint8Array | unknown> {
  if (!key || !(data instanceof Uint8Array)) return data;

  if (isSealTarget(key)) {
    const sealed = await sealToPublicKey(key.recipientPublicKey, data, key.aad);
    return encodeWithFormatPrefix(SerializationFormat.SEALED, sealed);
  }

  // Symmetric path — a run's own payloads, including when the caller holds
  // the full `RunPayloadKeys` bundle and *could* seal. See `PayloadKey`.
  const aesKey = isRunPayloadKeys(key) ? key.aes : key;
  const encrypted = await aesGcmEncrypt(aesKey, data);
  return encodeWithFormatPrefix(SerializationFormat.ENCRYPTED, encrypted);
}

/**
 * Decrypt a format-prefixed payload if it's encrypted or sealed.
 *
 * Strips the `encr`/`encp` format prefix and recovers the inner payload.
 * Opening a sealed (`encp`) payload requires the run's X25519 keypair, so the
 * caller must supply {@link RunPayloadKeys} — a bare symmetric key cannot do
 * it, and neither can a {@link SealTarget} (which is write-only by design).
 *
 * @param data - The potentially encrypted data
 * @param key - Encryption key (undefined to skip decryption)
 * @returns The decrypted inner payload, or the original data if not encrypted
 */
/**
 * Open a sealed (`encp`) envelope. Split out from {@link decrypt} to keep
 * each scheme's error handling readable on its own.
 */
async function openSealedEnvelope(
  data: Uint8Array,
  key: PayloadKey | undefined
): Promise<Uint8Array> {
  // Sealed payloads need the private scalar. Anything else — no key, a bare
  // symmetric key, or a write-only seal target — cannot open them.
  if (!isRunPayloadKeys(key)) {
    throw new RuntimeDecryptionError(
      'Sealed data encountered but no run keypair is available. ' +
        "Opening a sealed payload requires the run's own encryption key " +
        'material; a symmetric key or a seal-only target cannot decrypt it.',
      {
        context: {
          operation: 'decrypt',
          byteLength: data.byteLength,
          formatPrefix: 'encp',
        },
      }
    );
  }

  const { payload } = decodeFormatPrefix(data);
  try {
    return await openSealed(key.keyPair, payload, key.aad);
  } catch (error) {
    // The sealed-box layer only sees the stripped payload, so it cannot
    // record the outer envelope prefix. Enrich it here before rethrowing.
    if (RuntimeDecryptionError.is(error) && error.context) {
      error.context.formatPrefix = SerializationFormat.SEALED;
    }
    throw error;
  }
}

export async function decrypt(
  data: Uint8Array | unknown,
  key: PayloadKey | undefined
): Promise<Uint8Array | unknown> {
  // Non-binary data is returned as-is.
  if (!(data instanceof Uint8Array)) return data;

  const format = peekFormatPrefix(data);

  if (format === SerializationFormat.SEALED) {
    return openSealedEnvelope(data, key);
  }

  // If the data is not encrypted, return it unchanged.
  if (format !== SerializationFormat.ENCRYPTED) return data;

  // If the data is encrypted but no symmetric key is available, fail fast.
  const aesKey = aesKeyOf(key);
  if (!aesKey) {
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

  const { payload } = decodeFormatPrefix(data);
  try {
    return await aesGcmDecrypt(aesKey, payload);
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
