import { type CompressionStats, compress, decompress } from './compression.js';
import {
  type DecryptionKey,
  decrypt,
  encrypt,
  type PayloadKey,
} from './encryption.js';

/** Apply the storage layers in their only valid order: compress, then encrypt. */
export async function encodePayload(
  data: Uint8Array,
  key: PayloadKey | undefined,
  compression: boolean,
  stats?: CompressionStats
): Promise<Uint8Array> {
  return encrypt(await compress(data, compression, stats), key);
}

/** Remove the storage layers in reverse order: decrypt, then decompress. */
export async function decodePayload(
  data: Uint8Array,
  key: DecryptionKey | undefined,
  stats?: CompressionStats
): Promise<Uint8Array> {
  return decompress(await decrypt(data, key), stats);
}
