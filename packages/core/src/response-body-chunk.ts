/**
 * Chunk sizing for workflow `response.body` readers. Shared by the node:vm
 * engine, the QuickJS prelude and the `__builtin_response_read_chunk` host
 * step so all three agree on byte ranges, which must be replay-stable.
 *
 * The size of the read at `offset` is `offset` itself, clamped to
 * [MIN, MAX]: 64 KiB, 64 KiB, 128 KiB, 256 KiB, ... up to MAX. Reading a
 * stored body of B bytes therefore takes O(log B) steps (until the cap) and
 * O(B) total prefix I/O, while a single read never allocates more than the
 * larger of MIN and the bytes the consumer has already accepted, so consumer
 * byte limits still stop the read within about 2x of the limit.
 */
export const RESPONSE_BODY_CHUNK_MIN_BYTES = 64 * 1024;
export const RESPONSE_BODY_CHUNK_MAX_BYTES = 8 * 1024 * 1024;

export function responseBodyChunkSize(offset: number): number {
  return Math.min(
    RESPONSE_BODY_CHUNK_MAX_BYTES,
    Math.max(RESPONSE_BODY_CHUNK_MIN_BYTES, offset)
  );
}
