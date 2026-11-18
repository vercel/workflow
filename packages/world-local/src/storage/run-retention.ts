/**
 * Zero retention (`experimental_retention: 0`, the `$retention: '0'`
 * attribute): once a run finishes, its user data goes and the run stays
 * listable.
 *
 * The run's own payloads are dropped in the write that makes it terminal
 * (`withRunPayloadsPurged` in `events-storage.ts`); everything else it owns
 * (step payloads, event payloads, hook metadata, stream chunks) is scrubbed
 * by `purgeRunData` in the same transaction, so a purged run is never
 * observable with any of its data left. The connection zeroes freed pages
 * (`secure_delete`), and the WAL, which still holds the old pages, is
 * checkpointed and truncated right after the purge commits.
 *
 * A step still running when the run finished (a `Promise.race` loser) may
 * settle after it, and a stream may first be written after it: those writes
 * are scrubbed or refused as they land (`ranPurge`).
 */

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import {
  getEventDataRefFields,
  isTerminalWorkflowRunStatus,
  RETENTION_ATTRIBUTE,
  readRunRetention,
} from '@workflow/world';
import { decode, encode } from '../db/codec.js';
import type { Database } from '../db/index.js';
import {
  DOC_BYTES_SQL,
  EntityBytes,
  measureStreamBytes,
  readPurgedUsage,
  savePurgedUsage,
} from './purged-usage.js';

export function purgesUserDataOnFinish(
  attributes: Record<string, string> | undefined
): boolean {
  const retention = readRunRetention(attributes);
  if (retention.unsupported) {
    console.warn(
      `[world-local] Ignoring unrecognized ${RETENTION_ATTRIBUTE} value ` +
        `${JSON.stringify(retention.raw)}; keeping the run's data.`
    );
  }
  return retention.mode === 'none';
}

/**
 * Whether a run's user data was purged when it finished: it is terminal and
 * asked for zero retention. Not `expiredAt`, which is a retention deadline.
 */
export function ranPurge(run: WorkflowRun | undefined): boolean {
  return (
    run !== undefined &&
    isTerminalWorkflowRunStatus(run.status) &&
    readRunRetention(run.attributes).mode === 'none'
  );
}

/**
 * Scrubs a finished run's user data. Runs inside a transaction, when the run
 * finishes and again when a late step write lands (`late`).
 *
 * First it saves what the run wrote (`savePurgedUsage`): deleting the data
 * saves on Data Retained, not Data Written. The event sizes come from the
 * pass that scrubs the events (the rows are read before any is rewritten),
 * so the only extra read is the run's stream bytes, from their index. A
 * later purge adds the rows written since the last save, before scrubbing
 * them, so a late payload counts in full and the sizes never shrink. A run
 * purged before sizes were saved has nothing to add to: its earlier rows
 * are already scrubbed, so it saves nothing and reports what is left.
 *
 * This rewrites the run's event rows in place, and it is the only path that
 * does: the usage cache (`usage-storage.ts`) counts only rows after the last
 * position it counted and relies on that. Usage handles the purge by
 * reporting the sizes saved here and recounting the purged run.
 */
export function purgeRunData(
  db: Database,
  runId: string,
  { late = false }: { late?: boolean } = {}
): void {
  for (const row of db.all<{ step_id: string; doc: string }>(
    'SELECT step_id, doc FROM steps WHERE run_id = ?',
    runId
  )) {
    const step = decode<Step>(row.doc);
    step.input = undefined as never;
    step.output = undefined;
    step.error = undefined;
    db.run(
      'UPDATE steps SET doc = ? WHERE run_id = ? AND step_id = ?',
      encode(step),
      runId,
      row.step_id
    );
  }

  const saved = readPurgedUsage(db, runId);
  const written = new EntityBytes();
  let lastSeq = 0;
  const events = db.all<{
    seq: number;
    event_type: string;
    doc: string;
    bytes: number;
  }>(
    `SELECT seq, event_type, doc, ${DOC_BYTES_SQL} AS bytes
     FROM events WHERE run_id = ?`,
    runId
  );
  for (const row of events) {
    lastSeq = Math.max(lastSeq, Number(row.seq));
    // Rows up to the last save are in its sizes, and already scrubbed.
    if (saved && Number(row.seq) <= saved.seq) continue;
    written.add(row.event_type, row.bytes);
  }
  // The earlier purge deleted the chunks it measured: these came after it.
  written.byEntity.stream = measureStreamBytes(db, runId);
  if (saved) {
    savePurgedUsage(db, runId, {
      seq: lastSeq,
      byEntity: {
        run: saved.byEntity.run + written.byEntity.run,
        step: saved.byEntity.step + written.byEntity.step,
        hook: saved.byEntity.hook + written.byEntity.hook,
        stream: saved.byEntity.stream + written.byEntity.stream,
      },
    });
  } else if (!late) {
    savePurgedUsage(db, runId, { seq: lastSeq, byEntity: written.byEntity });
  }

  for (const row of events) {
    const event = decode<Event & { eventData?: Record<string, unknown> }>(
      row.doc
    );
    const eventData = event.eventData;
    if (!eventData || typeof eventData !== 'object') continue;
    for (const field of getEventDataRefFields(String(event.eventType))) {
      delete eventData[field];
    }
    if (
      event.eventType === 'run_created' ||
      event.eventType === 'run_started'
    ) {
      delete eventData.dynamicWorkflowCode;
      delete eventData.dynamicWorkflowCodeRef;
      // A start Hook's metadata is user data; its token and retention are not.
      const startHook = eventData.startHook as
        | Record<string, unknown>
        | undefined;
      if (startHook && typeof startHook === 'object') delete startHook.metadata;
    }
    db.run(
      'UPDATE events SET doc = ? WHERE run_id = ? AND seq = ?',
      encode(event),
      runId,
      row.seq
    );
  }

  // A hook kept for its token's retention keeps its token, not its payload.
  for (const row of db.all<{ hook_id: string; doc: string }>(
    'SELECT hook_id, doc FROM hooks WHERE run_id = ?',
    runId
  )) {
    const hook = decode<Hook>(row.doc);
    hook.metadata = undefined;
    db.run(
      'UPDATE hooks SET doc = ? WHERE hook_id = ?',
      encode(hook),
      row.hook_id
    );
  }

  purgeRunStreams(db, runId);
}

/**
 * Drops a run's stream chunks and leaves each stream an end-of-stream
 * marker at index 0, so a purged stream reads as empty and done rather than
 * as one still being written.
 */
export function purgeRunStreams(db: Database, runId: string): void {
  const names = db.all<{ name: string; tag: string | null }>(
    'SELECT DISTINCT name, tag FROM stream_chunks WHERE run_id = ?',
    runId
  );
  db.run('DELETE FROM stream_chunks WHERE run_id = ?', runId);
  for (const { name, tag } of names) {
    db.run(
      'INSERT INTO stream_chunks (name, idx, run_id, tag, data, eof) VALUES (?, 0, ?, ?, NULL, 1)',
      name,
      runId,
      tag
    );
  }
}
