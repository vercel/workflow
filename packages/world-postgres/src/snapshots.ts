import type { SnapshotMetadata, Storage } from '@workflow/world';
import {
  decodeSnapshotEnvelope,
  encodeSnapshotEnvelope,
} from '@workflow/world';
import { eq } from 'drizzle-orm';
import { type Drizzle, Schema } from './drizzle/index.js';

/**
 * Snapshot storage for world-postgres.
 *
 * Compression and encryption are handled by `@workflow/core`'s
 * snapshot entrypoint (`compress(snapshot) → encrypt → save`). This
 * world layer treats the bytes as opaque — it does NOT add its own
 * compression.
 *
 * The `data` column stores a snapshot ENVELOPE (metadata + bytes in one
 * blob; see `encodeSnapshotEnvelope`): the full metadata object
 * round-trips losslessly through the envelope, so new metadata fields
 * never require a schema migration, and the metadata/bytes pairing is
 * atomic by construction. The `events_cursor` / `created_at` columns
 * are denormalized copies kept for observability (SQL inspection) —
 * loads read the envelope, never the columns.
 *
 * Each run has at most one row; `save()` upserts the latest
 * suspension's bytes.
 */
export function createSnapshotsStorage(
  drizzle: Drizzle
): NonNullable<Storage['snapshots']> {
  const { snapshots } = Schema;

  return {
    async save(
      runId: string,
      data: Uint8Array,
      metadata: SnapshotMetadata
    ): Promise<void> {
      const blob = Buffer.from(encodeSnapshotEnvelope(metadata, data));
      await drizzle
        .insert(snapshots)
        .values({
          runId,
          data: blob,
          eventsCursor: metadata.eventsCursor,
          createdAt: metadata.createdAt,
        })
        .onConflictDoUpdate({
          target: snapshots.runId,
          set: {
            data: blob,
            eventsCursor: metadata.eventsCursor,
            createdAt: metadata.createdAt,
          },
        });
    },

    async load(
      runId: string
    ): Promise<{ data: Uint8Array; metadata: SnapshotMetadata } | null> {
      const [row] = await drizzle
        .select()
        .from(snapshots)
        .where(eq(snapshots.runId, runId))
        .limit(1);

      if (!row) return null;

      // Anything that fails to decode (corrupt, unknown version,
      // schema-invalid metadata) is a clean miss — the caller falls back
      // to full replay, never to fabricated metadata.
      return decodeSnapshotEnvelope(
        new Uint8Array(
          row.data.buffer,
          row.data.byteOffset,
          row.data.byteLength
        )
      );
    },

    async delete(runId: string): Promise<void> {
      // Plain DELETE — naturally idempotent (0 rows affected is success).
      await drizzle.delete(snapshots).where(eq(snapshots.runId, runId));
    },
  };
}
