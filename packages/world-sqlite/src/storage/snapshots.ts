import type { SnapshotMetadata } from '@workflow/world';
import {
  decodeSnapshotEnvelope,
  encodeSnapshotEnvelope,
} from '@workflow/world';
import { assertSafeEntityId, type Ctx } from './common.js';

export function createSnapshotsStorage(ctx: Ctx) {
  const { db } = ctx;
  return {
    async save(
      runId: string,
      data: Uint8Array,
      metadata: SnapshotMetadata
    ): Promise<void> {
      assertSafeEntityId('runId', runId);
      db.run(
        `INSERT INTO snapshots (run_id, data) VALUES (?, ?)
         ON CONFLICT (run_id) DO UPDATE SET data = excluded.data`,
        runId,
        encodeSnapshotEnvelope(metadata, data)
      );
    },

    async load(
      runId: string
    ): Promise<{ data: Uint8Array; metadata: SnapshotMetadata } | null> {
      assertSafeEntityId('runId', runId);
      const row = db.get<{ data: Uint8Array }>(
        'SELECT data FROM snapshots WHERE run_id = ?',
        runId
      );
      return row ? decodeSnapshotEnvelope(Uint8Array.from(row.data)) : null;
    },

    async delete(runId: string): Promise<void> {
      assertSafeEntityId('runId', runId);
      db.run('DELETE FROM snapshots WHERE run_id = ?', runId);
    },
  };
}
