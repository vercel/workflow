/**
 * Zero retention (`experimental_retention: 0`, the `$retention: '0'`
 * attribute): once a run finishes, its user data goes and the run stays
 * listable.
 *
 * The run's own payloads are dropped in the write that makes it terminal
 * (`withRunPayloadsPurged` in `events-storage.ts`); everything else it owns
 * (step payloads, event payloads, hook metadata, stream chunks) is scrubbed
 * by `purgeRunData` in the same transaction, so a purged run is never
 * observable with any of its data left.
 */

import type { Event, Hook, Step } from '@workflow/world';
import {
  getEventDataRefFields,
  RETENTION_ATTRIBUTE,
  readRunRetention,
} from '@workflow/world';
import { decode, encode } from '../db/codec.js';
import type { Database } from '../db/index.js';

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

/** Scrubs a finished run's user data. Runs inside a transaction. */
export function purgeRunData(db: Database, runId: string): void {
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

  for (const row of db.all<{ seq: number; doc: string }>(
    'SELECT seq, doc FROM events WHERE run_id = ?',
    runId
  )) {
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
