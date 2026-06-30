// ============================================================================
// framed-v2 writer markers
// ============================================================================
//
// `framed-v2` extends the length-prefixed frame format (`framed-v1`, see
// `getByteFramingStream` / `getSerializeStream`) with a per-writer marker
// carried in the frame header, immediately after the 4-byte frame length and
// before the inner payload:
//
//   [4-byte BE frame length][writerId: 8 bytes][seq: 8-byte BE uint64][inner]
//
// where the frame length covers everything after it (marker + inner payload),
// exactly as in framed-v1 (which has no marker). The marker bytes are stored
// by the world transport as part of the opaque chunk and stripped by the
// reader's unframer before the inner payload reaches the consumer.
//
// The marker exists for the single-request streaming writer:
//
//  - On recovery after an unclean disconnect, a writer fetches the persisted
//    stream tail and must locate its OWN frames. Multiple writers may
//    interleave into one stream (concurrent steps / parent→child forwarding),
//    so the shared server chunk index is not attributable to one writer — the
//    `writerId` is. The writer resumes from `max(seq)` it finds for its id.
//  - The reader can dedupe a frame that recovery re-sent after it had in fact
//    already been persisted (tracking the max `seq` seen per `writerId`).
//
// `writerId` identifies one logical writer (one `WorkflowServerWritableStream`
// instance) for the lifetime of the stream. `seq` is a per-writer monotonic
// counter starting at 0. Both MUST be stable across deterministic replays —
// the writerId source (see serialization.ts) derives it from the VM's seeded
// ULID inside the workflow sandbox so two replays produce identical bytes.

/**
 * Size of the frame length prefix, shared by framed-v1 and framed-v2. The
 * frame length is a 4-byte big-endian unsigned integer counting the bytes
 * that follow it (the marker, when present, plus the inner payload).
 */
export const FRAME_HEADER_SIZE = 4;

/** Bytes of writer identity in a framed-v2 marker. */
export const WRITER_ID_SIZE = 8;

/** Total marker size: writerId + 8-byte big-endian uint64 sequence number. */
export const FRAME_MARKER_SIZE = WRITER_ID_SIZE + 8;

export interface FrameMarker {
  /** Exactly {@link WRITER_ID_SIZE} bytes identifying the writer. */
  writerId: Uint8Array;
  /** Per-writer monotonic sequence number (starts at 0). */
  seq: bigint;
}

/**
 * Build a complete framed-v2 frame: `[len][writerId][seq][inner]`. The
 * length prefix covers the marker and the inner payload. Used by both the
 * byte framer and the object serializer so the wire layout stays in one place.
 */
export function buildFramedV2Frame(
  inner: Uint8Array,
  marker: FrameMarker
): Uint8Array {
  if (marker.writerId.length !== WRITER_ID_SIZE) {
    throw new RangeError(
      `writerId must be ${WRITER_ID_SIZE} bytes, got ${marker.writerId.length}`
    );
  }
  const bodyLength = FRAME_MARKER_SIZE + inner.length;
  const frame = new Uint8Array(FRAME_HEADER_SIZE + bodyLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, bodyLength, false);
  frame.set(marker.writerId, FRAME_HEADER_SIZE);
  view.setBigUint64(FRAME_HEADER_SIZE + WRITER_ID_SIZE, marker.seq, false);
  frame.set(inner, FRAME_HEADER_SIZE + FRAME_MARKER_SIZE);
  return frame;
}

/**
 * Read a marker from the start of a frame body (i.e. the bytes after the
 * 4-byte length prefix). The caller must guarantee at least
 * {@link FRAME_MARKER_SIZE} bytes are available at `offset`.
 */
export function readFrameMarker(body: Uint8Array, offset = 0): FrameMarker {
  const writerId = body.slice(offset, offset + WRITER_ID_SIZE);
  const seq = new DataView(
    body.buffer,
    body.byteOffset + offset + WRITER_ID_SIZE,
    8
  ).getBigUint64(0, false);
  return { writerId, seq };
}

/**
 * Stable hex string for a writerId, suitable as a Map/Set key (Uint8Array
 * has reference identity, so it can't key a Map directly).
 */
export function writerIdKey(writerId: Uint8Array): string {
  let key = '';
  for (let i = 0; i < writerId.length; i++) {
    key += writerId[i].toString(16).padStart(2, '0');
  }
  return key;
}

/**
 * Derive a compact {@link WRITER_ID_SIZE}-byte writerId from a seed string via
 * FNV-1a (64-bit, emitted big-endian).
 *
 * The caller passes a value that is unique per logical writer and **stable
 * across deterministic replays** — in practice a ULID from the workflow VM's
 * seeded generator (`STABLE_ULID`). Deriving the id from that seed (rather than
 * from `crypto.getRandomValues`) keeps it replay-deterministic without
 * consuming the VM's seeded RNG, which would shift the sequence observed by
 * user code. FNV-1a is not cryptographic; it only needs low collision
 * probability among the few writers that may share one stream.
 */
export function deriveWriterId(seed: string): Uint8Array {
  let hash = 0xcbf29ce484222325n; // FNV-1a 64-bit offset basis
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  const bytes = new TextEncoder().encode(seed);
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash ^ BigInt(bytes[i])) * prime) & mask;
  }
  const out = new Uint8Array(WRITER_ID_SIZE);
  new DataView(out.buffer).setBigUint64(0, hash, false);
  return out;
}
