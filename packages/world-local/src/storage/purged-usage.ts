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

/**
 * Where each event type carries its payloads (the data the client sends):
 * the serialized values of its `eventData`. Everything else in an event
 * (ids, timestamps, the step name, attribute writes) is metadata, which
 * Data Written does not count.
 */
const PAYLOAD_PATHS: Readonly<Record<string, readonly string[]>> = {
  // A dynamic run's code is kept on the run, not on its events, so it is
  // not here.
  run_created: ['$.eventData.input', '$.eventData.startHook.metadata'],
  run_started: ['$.eventData.input', '$.eventData.startHook.metadata'],
  run_completed: ['$.eventData.output'],
  run_failed: ['$.eventData.error'],
  step_created: ['$.eventData.input'],
  step_started: ['$.eventData.input'],
  step_completed: ['$.eventData.result'],
  step_failed: ['$.eventData.error'],
  step_retrying: ['$.eventData.error'],
  hook_created: ['$.eventData.metadata'],
  hook_received: ['$.eventData.payload'],
};

/** The event types {@link PAYLOAD_BYTES_SQL} reads payloads of (tests). */
export const PAYLOAD_EVENT_TYPES = Object.keys(PAYLOAD_PATHS);

/**
 * The bytes of the value at `path`: a `Uint8Array` (every payload the SDK
 * serializes, stored as `{ "__type": "Uint8Array", "data": "<base64>" }`)
 * by the length its base64 decodes to, without decoding it; any other value
 * (a legacy payload serialized as JSON) by its JSON text.
 */
function valueBytesSql(path: string): string {
  // As a BLOB, `length` and `substr` count bytes from the end of the string
  // the parse already made, instead of walking it as text: about 2.5x
  // faster on large payloads. Base64 is ASCII, so bytes are characters.
  const data = `CAST(json_extract(doc, '${path}.data') AS BLOB)`;
  return `CASE WHEN json_extract(doc, '${path}.__type') = 'Uint8Array'
    THEN length(${data}) / 4 * 3 - (CASE WHEN substr(${data}, -2) = X'3D3D' THEN 2 WHEN substr(${data}, -1) = X'3D' THEN 1 ELSE 0 END)
    ELSE coalesce(length(CAST(doc -> '${path}' AS BLOB)), 0) END`;
}

/**
 * An event row's payload bytes, the way Data Written counts them: the bytes
 * of its payloads (compressed or encrypted as the SDK sent them), not the
 * row's JSON or the event's metadata. Computed in SQL from the base64
 * strings' lengths. One `CASE` arm per event type, so a row reads only its
 * own payload fields, and SQLite parses each row's JSON once per statement.
 */
export const PAYLOAD_BYTES_SQL = `(CASE event_type ${Object.entries(
  PAYLOAD_PATHS
)
  .map(
    ([eventType, paths]) =>
      `WHEN '${eventType}' THEN ${paths.map((path) => `(${valueBytesSql(path)})`).join(' + ')}`
  )
  .join(' ')} ELSE 0 END)`;

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
