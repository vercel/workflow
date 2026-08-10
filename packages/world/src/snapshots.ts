import { z } from 'zod';

export const SnapshotMetadataSchema = z.object({
  /**
   * Pagination cursor for events.list() — the snapshot was taken at
   * this point in the event log. On restore, only events AFTER this
   * cursor need to be fetched.
   */
  eventsCursor: z.string().nullable(),
  /** Timestamp when the snapshot was created */
  createdAt: z.coerce.date(),
  /**
   * Number of events the run had processed when the snapshot was taken.
   * Restores see only the delta after `eventsCursor`, so guards that need
   * the TOTAL log size (the server-supplied max-events ceiling) add this
   * to the delta. Optional for snapshots written before the field existed
   * (treated as 0 — the ceiling degrades to delta-only for those, exactly
   * the pre-field behavior).
   */
  eventCount: z.number().int().nonnegative().optional(),
  /**
   * Number of draws the run's seeded PRNG had consumed when the snapshot
   * was taken. On restore the runtime re-seeds from the run's BASE seed
   * and fast-forwards this many draws, so correlation-id generation
   * continues at the exact position full replay would have reached —
   * keeping ids identical across snapshot generations AND identical to a
   * no-snapshot run (which is what makes concurrent invocations restored
   * from different snapshots of the same run still collide on the world's
   * per-(runId, correlationId) dedup).
   */
  rngDraws: z.number().int().nonnegative().optional(),
  /**
   * Snapshot-portable token of the engine's host-serde capture root: the
   * container of pristine intrinsics/samples/symbols captured before any
   * user code ran, whose box lives inside the snapshot's memory image. A
   * restore re-adopts it by this token so serde initialization executes
   * no guest code after user code has run. Required to restore (format
   * version >= 2); snapshots without it are treated as a miss.
   */
  serdeRootPtr: z.number().int().optional(),
  /**
   * The monotonic correlation-id ULID factory's last output when the
   * snapshot was taken (undefined if the run had drawn none). The
   * factory's state lives host-side and does not survive into the memory
   * image; on restore the runtime continues the sequence from this value
   * (same-timestamp base32 increment), so a restored invocation emits
   * the exact ids a full replay would — keeping concurrent invocations
   * of the same run dedupable via per-(runId, correlationId) uniqueness.
   */
  lastUlid: z.string().optional(),
  /**
   * Snapshot format tag. A reader that doesn't recognize the version
   * treats the snapshot as a clean miss (full replay) instead of handing
   * an incompatible heap to the WASM engine.
   */
  formatVersion: z.number().int().optional(),
});

/**
 * Current snapshot format version, bumped when the heap layout or the
 * metadata contract changes incompatibly.
 *
 * v2: host-side serde + host-side ULID factory (post-#3263 engine) —
 * adds required `serdeRootPtr` and `lastUlid` continuation state. v1
 * snapshots (in-VM serde era) cannot be restored by this engine and are
 * treated as a miss.
 */
export const SNAPSHOT_FORMAT_VERSION = 2;

export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;

// ---------------------------------------------------------------------------
// Snapshot envelope
//
// Packs the metadata and the snapshot bytes into ONE self-describing blob so
// that a World backed by a plain blob store can persist both with a single
// atomic write. Two separate writes (bytes here, metadata there) can tear: a
// crash between them — or a concurrent load interleaving them — pairs bytes
// from one suspension with an eventsCursor from another, and the restore
// replays from the wrong log position and silently diverges. The envelope
// makes that structurally impossible, and it also means new metadata fields
// round-trip through every envelope-based World without storage changes.
//
// Layout (little-endian):
//   bytes 0..4   magic "WSNP"
//   byte  4      envelope format version (1)
//   bytes 5..9   u32 metadata JSON byte length
//   bytes 9..9+N metadata JSON (UTF-8, SnapshotMetadataSchema-valid)
//   bytes 9+N..  snapshot data (opaque)
// ---------------------------------------------------------------------------

const ENVELOPE_MAGIC = [0x57, 0x53, 0x4e, 0x50]; // "WSNP"
const ENVELOPE_VERSION = 1;
const ENVELOPE_HEADER_LEN = 9;

/** Encode a snapshot's metadata and bytes into one atomic blob. */
export function encodeSnapshotEnvelope(
  metadata: SnapshotMetadata,
  data: Uint8Array
): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const out = new Uint8Array(
    ENVELOPE_HEADER_LEN + metaBytes.length + data.length
  );
  out.set(ENVELOPE_MAGIC, 0);
  out[4] = ENVELOPE_VERSION;
  new DataView(out.buffer).setUint32(5, metaBytes.length, true);
  out.set(metaBytes, ENVELOPE_HEADER_LEN);
  out.set(data, ENVELOPE_HEADER_LEN + metaBytes.length);
  return out;
}

/**
 * Decode a snapshot envelope. Returns null for anything that is not a
 * well-formed, schema-valid envelope (wrong magic, unknown version,
 * truncated, invalid JSON, schema violation) — the caller treats that as
 * a clean miss (full replay) rather than restoring from fabricated or
 * torn state. Never invents metadata.
 */
export function decodeSnapshotEnvelope(
  bytes: Uint8Array
): { metadata: SnapshotMetadata; data: Uint8Array } | null {
  if (bytes.length < ENVELOPE_HEADER_LEN) return null;
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) {
    if (bytes[i] !== ENVELOPE_MAGIC[i]) return null;
  }
  if (bytes[4] !== ENVELOPE_VERSION) return null;
  const metaLen = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(5, true);
  if (ENVELOPE_HEADER_LEN + metaLen > bytes.length) return null;
  try {
    const metaJson = new TextDecoder().decode(
      bytes.subarray(ENVELOPE_HEADER_LEN, ENVELOPE_HEADER_LEN + metaLen)
    );
    // `.passthrough()`: metadata fields introduced by a newer schema
    // survive a decode by this one (the whole point of enveloping the
    // metadata is that new fields never require storage changes) —
    // known fields are still validated.
    const metadata = SnapshotMetadataSchema.passthrough().parse(
      JSON.parse(metaJson)
    ) as SnapshotMetadata;
    return {
      metadata,
      data: bytes.subarray(ENVELOPE_HEADER_LEN + metaLen),
    };
  } catch {
    return null;
  }
}
