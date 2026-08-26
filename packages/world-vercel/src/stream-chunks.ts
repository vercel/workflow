/** Shared HTTP/WS request-work bound matching the server batch cap. */
export const MAX_CHUNKS_PER_STREAM_WRITE = 1000;

export function normalizeStreamChunks(
  chunks: (string | Uint8Array)[]
): Uint8Array[] {
  const encoder = new TextEncoder();
  return chunks.map((chunk) =>
    typeof chunk === 'string' ? encoder.encode(chunk) : chunk
  );
}

/**
 * Encode stream chunks into the existing length-prefixed binary format:
 * `chunk* := u32_be(chunk_length) || chunk_bytes`.
 *
 * Shared by HTTP multi-chunk writes and `workflow-stream-ws/v1` so the
 * transport changes only the outer envelope, not the persisted chunk format.
 */
export function encodeMultiChunks(chunks: (string | Uint8Array)[]): Uint8Array {
  return encodeNormalizedMultiChunks(normalizeStreamChunks(chunks));
}

export function encodeNormalizedMultiChunks(
  binaryChunks: Uint8Array[]
): Uint8Array {
  let totalSize = 0;
  for (const binary of binaryChunks) {
    totalSize += 4 + binary.length;
    if (totalSize > 0xffff_ffff) {
      throw new RangeError(
        `encoded stream chunks exceed the u32 body-length limit: ${totalSize} bytes`
      );
    }
  }
  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let offset = 0;

  for (const binary of binaryChunks) {
    view.setUint32(offset, binary.length, false);
    offset += 4;
    result.set(binary, offset);
    offset += binary.length;
  }

  return result;
}
