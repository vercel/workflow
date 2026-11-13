import type { SnapshotMetadata } from '@workflow/world';
import {
  decodeSnapshotEnvelope,
  encodeSnapshotEnvelope,
} from '@workflow/world';
import type { Database } from '../db/index.js';
import { assertSafeEntityId } from '../ids.js';

/**
 * QuickJS VM snapshots: one envelope (metadata plus the opaque snapshot
 * bytes, see `encodeSnapshotEnvelope`) per run, replaced whole, so a heap
 * image is never paired with another suspension's cursor.
 */
export function createSnapshotsStorage(db: Database) {
  return {
    async save(
      runId: string,
      data: Uint8Array,
      metadata: SnapshotMetadata
    ): Promise<void> {
      assertSafeEntityId('runId', runId);
      db.run(
        `INSERT INTO snapshots (run_id, envelope) VALUES (?, ?)
         ON CONFLICT (run_id) DO UPDATE SET envelope = excluded.envelope`,
        runId,
        encodeSnapshotEnvelope(metadata, data)
      );
    },

    async load(
      runId: string
    ): Promise<{ data: Uint8Array; metadata: SnapshotMetadata } | null> {
      assertSafeEntityId('runId', runId);
      const row = db.get<{ envelope: Uint8Array }>(
        'SELECT envelope FROM snapshots WHERE run_id = ?',
        runId
      );
      if (!row) return null;
      // Anything that fails to decode is a clean miss: the caller falls back
      // to a full replay.
      return decodeSnapshotEnvelope(new Uint8Array(row.envelope));
    },

    async delete(runId: string): Promise<void> {
      assertSafeEntityId('runId', runId);
      db.run('DELETE FROM snapshots WHERE run_id = ?', runId);
    },
  };
}
