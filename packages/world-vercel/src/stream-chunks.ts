/**
 * Encode stream chunks into the existing length-prefixed binary format:
 * `chunk* := u32_be(chunk_length) || chunk_bytes`.
 *
 * Shared by HTTP multi-chunk writes and `workflow-stream-ws/v1` so the
 * transport changes only the outer envelope, not the persisted chunk format.
 */
export function encodeMultiChunks(chunks: (string | Uint8Array)[]): Uint8Array {
  const encoder = new TextEncoder();
  const binaryChunks: Uint8Array[] = [];
  let totalSize = 0;

  for (const chunk of chunks) {
    const binary = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    binaryChunks.push(binary);
    totalSize += 4 + binary.length;
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
