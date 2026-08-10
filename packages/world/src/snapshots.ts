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
