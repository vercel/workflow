/**
 * What a run wrote, saved when its data is deleted.
 *
 * Usage reports Data Written from the run's rows (`usage-storage.ts`). A run
 * started with `experimental_retention: 0` has its payloads deleted in the
 * transaction that makes it terminal (`purgeRunData`), and any finished
 * run's can be deleted on demand (`runs.deleteDataMany`); after that its
 * rows hold almost nothing. Deleting the data saves on Data Retained, not on
 * Data Written, so the purge first adds up the sizes it is about to delete
 * and saves them here, with the log position they cover. Usage then reports
 * the saved sizes plus anything the run wrote after that position, and a
 * late step write moves that position forward (`purgeLateStepWrite`).
 *
 * The table is created on first use, outside the schema migrations, so the
 * database's `user_version` does not change: a world-local that predates it
 * (an older CLI or web UI reading the app's data directory) opens the
 * database as before and ignores the table, and one that has it falls back
 * to measuring what is left for runs purged without it.
 */

import { type RunUsageEntity, usageEntityOfEventType } from '@workflow/world';
import type { Database } from '../db/index.js';

/** A stored row's size in bytes, measured the same way everywhere. */
export const DOC_BYTES_SQL = 'length(CAST(doc AS BLOB))';

const STREAM_BYTES_SQL = `
  SELECT COALESCE(SUM(length(data)), 0) AS bytes
  FROM stream_chunks
  WHERE run_id = ?
`;

/** The bytes of a run's stream chunks. */
export function measureStreamBytes(db: Database, runId: string): number {
  return Number(db.get<{ bytes: number }>(STREAM_BYTES_SQL, runId)?.bytes ?? 0);
}

const TABLE = 'run_usage_purged';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    run_id TEXT PRIMARY KEY,
    -- The last log position the sizes below cover.
    seq INTEGER NOT NULL,
    run_bytes INTEGER NOT NULL,
    step_bytes INTEGER NOT NULL,
    hook_bytes INTEGER NOT NULL,
    stream_bytes INTEGER NOT NULL
  )
`;

export interface PurgedUsage {
  seq: number;
  byEntity: Record<RunUsageEntity, number>;
}

/** Adds up event rows' sizes by the entity Data Written reports them under. */
export class EntityBytes {
  readonly byEntity: Record<RunUsageEntity, number> = {
    run: 0,
    step: 0,
    hook: 0,
    stream: 0,
  };

  add(eventType: string, bytes: number): void {
    const entity = usageEntityOfEventType(eventType);
    if (entity) this.byEntity[entity] += Number(bytes) || 0;
  }
}

function tableExists(db: Database): boolean {
  return (
    db.get(
      "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?",
      TABLE
    ) !== undefined
  );
}

/**
 * Saves what a run wrote up to `seq`, replacing an earlier save. Inside the
 * purge's transaction. A run's data can be scrubbed more than once (a late
 * step write, a deletion on demand), and each save covers the one before
 * it: the caller adds what was written since to the sizes it read.
 */
export function savePurgedUsage(
  db: Database,
  runId: string,
  usage: PurgedUsage
): void {
  db.run(CREATE_TABLE_SQL);
  db.run(
    `INSERT INTO ${TABLE}
       (run_id, seq, run_bytes, step_bytes, hook_bytes, stream_bytes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET
       seq = excluded.seq,
       run_bytes = excluded.run_bytes,
       step_bytes = excluded.step_bytes,
       hook_bytes = excluded.hook_bytes,
       stream_bytes = excluded.stream_bytes`,
    runId,
    usage.seq,
    usage.byEntity.run,
    usage.byEntity.step,
    usage.byEntity.hook,
    usage.byEntity.stream
  );
}

/** What a purged run wrote, if it was saved. */
export function readPurgedUsage(
  db: Database,
  runId: string
): PurgedUsage | null {
  if (!tableExists(db)) return null;
  const row = db.get<{
    seq: number;
    run_bytes: number;
    step_bytes: number;
    hook_bytes: number;
    stream_bytes: number;
  }>(
    `SELECT seq, run_bytes, step_bytes, hook_bytes, stream_bytes
     FROM ${TABLE} WHERE run_id = ?`,
    runId
  );
  if (!row) return null;
  return {
    seq: Number(row.seq),
    byEntity: {
      run: Number(row.run_bytes),
      step: Number(row.step_bytes),
      hook: Number(row.hook_bytes),
      stream: Number(row.stream_bytes),
    },
  };
}

/** Deletes saved sizes with their runs (`clear()`). */
export function deletePurgedUsage(
  db: Database,
  where?: { runIdsSql: string; params: unknown[] }
): void {
  if (!tableExists(db)) return;
  if (!where) {
    db.run(`DELETE FROM ${TABLE}`);
    return;
  }
  db.run(
    `DELETE FROM ${TABLE} WHERE run_id IN (${where.runIdsSql})`,
    ...where.params
  );
}
