import { type CompressionStats, decompress } from './compression.js';
import { type DecryptionKey, decrypt } from './encryption.js';

/** Legacy payloads need no byte preparation but still share the hydrate API. */
export interface LegacyReplayPayload {
  readonly legacy: unknown;
}

/** Host-owned bytes, or a tagged legacy value from before binary envelopes. */
export type PreparedReplayPayload = Uint8Array | LegacyReplayPayload;

export type ReplayPayloadPreparer = (
  value: Uint8Array,
  key: DecryptionKey | undefined
) => Uint8Array | Promise<Uint8Array>;

/**
 * Decrypt and decompress persisted bytes without creating VM-owned values.
 *
 * AES-GCM, zstd, and Node gzip complete synchronously. Sealed envelopes and
 * portable browser gzip return a Promise because their underlying codecs do.
 */
export function prepareReplayPayload(
  value: Uint8Array,
  key: DecryptionKey | undefined,
  compressionStats?: CompressionStats
): Uint8Array | Promise<Uint8Array> {
  const decompressPayload = (decrypted: Uint8Array) =>
    decompress(decrypted, compressionStats);
  const decrypted = decrypt(value, key);
  return decrypted instanceof Promise
    ? decrypted.then(decompressPayload)
    : decompressPayload(decrypted);
}
