import type { CompressionStats } from './compression.js';
import type { DecryptionKey } from './encryption.js';
import { decodePayload } from './payload.js';

/** Host-owned bytes, or a tagged legacy value from before binary envelopes. */
export type PreparedReplayPayload = Uint8Array | { readonly legacy: unknown };

/**
 * Decrypt and decompress persisted bytes without creating VM-owned values.
 *
 * Native Node and portable browser codecs share one asynchronous contract.
 */
export async function prepareReplayPayload(
  value: Uint8Array,
  key: DecryptionKey | undefined,
  compressionStats?: CompressionStats
): Promise<Uint8Array> {
  return decodePayload(value, key, compressionStats);
}
