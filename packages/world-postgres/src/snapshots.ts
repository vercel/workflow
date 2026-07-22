import type { SnapshotMetadata, Storage } from '@workflow/world';
import { eq } from 'drizzle-orm';
import { type Drizzle, Schema } from './drizzle/index.js';

/**
 * Snapshot storage for world-postgres.
 *
 * Compression and encryption are handled by `@workflow/core`'s
 * snapshot entrypoint (`compress(snapshot) → encrypt → save`). This
 * world layer treats the bytes as opaque — it does NOT add its own
 * compression. Blobs are stored verbatim in the `data` column of
 * `workflow.workflow_snapshots`. Each run has at most one row;
 * `save()` upserts the latest suspension's bytes.
 */
export function createSnapshotsStorage(drizzle: Drizzle): Storage['snapshots'] {
  const { snapshots } = Schema;

  return {
    async save(
      runId: string,
      data: Uint8Array,
      metadata: SnapshotMetadata
    ): Promise<void> {
      const blob = Buffer.from(data);
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

      const data = new Uint8Array(
        row.data.buffer,
        row.data.byteOffset,
        row.data.byteLength
      );

      return {
        data,
        metadata: {
          eventsCursor: row.eventsCursor,
          createdAt: row.createdAt,
        },
      };
    },

    async delete(runId: string): Promise<void> {
      await drizzle.delete(snapshots).where(eq(snapshots.runId, runId));
    },
  };
}
