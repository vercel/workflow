import { RuntimeDecryptionError } from '@workflow/errors';
import {
  decrypt as aesGcmDecrypt,
  encrypt as aesGcmEncrypt,
  type CryptoKey,
  importKey as importAesKey,
} from '../encryption.js';
import {
  deriveRunKeyPair,
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
 * A write-only capability: seal payloads to a run's X25519 public key.
 */
export interface SealTarget {
  readonly kind: 'seal';
  readonly recipientPublicKey: Uint8Array;
  readonly aad: Uint8Array | undefined;
}

/**
 * A run's own AES key plus the keypair used to open sealed payloads.
 */
export interface RunPayloadKeys {
  readonly kind: 'run';
  readonly aes: CryptoKey;
  readonly keyPair: RunKeyPair;
  readonly aad: Uint8Array | undefined;
}

/**
 * A bare `CryptoKey` is the legacy symmetric-only shape. SDK-owned key
 * capabilities use `kind` so they can be handled exhaustively.
 */
export type PayloadKey = CryptoKey | SealTarget | RunPayloadKeys;

/** Key capabilities that can decrypt payloads. */
export type DecryptionKey = CryptoKey | RunPayloadKeys;

export function sealTo(
  recipientPublicKey: Uint8Array,
  aad?: Uint8Array
): SealTarget {
  return { kind: 'seal', recipientPublicKey, aad };
}

export function runPayloadKeys(
  aes: CryptoKey,
  keyPair: RunKeyPair,
  aad?: Uint8Array
): RunPayloadKeys {
  return { kind: 'run', aes, keyPair, aad };
}

/**
 * Derive every key needed to read a run's symmetric and sealed payloads.
 */
export async function deriveRunPayloadKeys(
  runKeyMaterial: Uint8Array
): Promise<RunPayloadKeys> {
  const [aes, keyPair] = await Promise.all([
    importAesKey(runKeyMaterial),
    deriveRunKeyPair(runKeyMaterial),
  ]);
  return runPayloadKeys(aes, keyPair);
}

/**
 * A key can be resolved eagerly or lazily. `undefined` disables encryption.
 */
export type EncryptionKeyParam =
  | PayloadKey
  | undefined
  | Promise<PayloadKey | undefined>
  | (() => Promise<PayloadKey | undefined>);

export function isSealTarget(key: PayloadKey | undefined): key is SealTarget {
  return key !== undefined && 'kind' in key && key.kind === 'seal';
}

export function isRunPayloadKeys(
  key: EncryptionKeyParam
): key is RunPayloadKeys {
  return typeof key === 'object' && 'kind' in key && key.kind === 'run';
}

export async function resolveEncryptionKey(
  key: EncryptionKeyParam
): Promise<PayloadKey | undefined> {
  return typeof key === 'function' ? key() : key;
}

function attachFormatPrefix(error: unknown, formatPrefix: string): void {
  if (RuntimeDecryptionError.is(error) && error.context) {
    error.context.formatPrefix = formatPrefix;
  }
}

export async function encrypt(
  data: unknown,
  key: PayloadKey | undefined
): Promise<unknown> {
  if (!key || !(data instanceof Uint8Array)) return data;

  if ('kind' in key) {
    switch (key.kind) {
      case 'seal': {
        const sealed = await sealToPublicKey(
          key.recipientPublicKey,
          data,
          key.aad
        );
        return encodeWithFormatPrefix(SerializationFormat.SEALED, sealed);
      }
      case 'run':
        key = key.aes;
        break;
      default:
        key satisfies never;
        throw new TypeError('Unknown payload key kind');
    }
  }

  const encrypted = await aesGcmEncrypt(key, data);
  return encodeWithFormatPrefix(SerializationFormat.ENCRYPTED, encrypted);
}

export async function decrypt(
  data: unknown,
  key: PayloadKey | undefined
): Promise<unknown> {
  if (!(data instanceof Uint8Array)) return data;

  const format = peekFormatPrefix(data);

  if (format === SerializationFormat.SEALED) {
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
      attachFormatPrefix(error, format);
      throw error;
    }
  }

  if (format !== SerializationFormat.ENCRYPTED) return data;

  if (!key || isSealTarget(key)) {
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

  if (isRunPayloadKeys(key)) key = key.aes;

  const { payload } = decodeFormatPrefix(data);
  try {
    return await aesGcmDecrypt(key, payload);
  } catch (error) {
    attachFormatPrefix(error, format);
    throw error;
  }
}
