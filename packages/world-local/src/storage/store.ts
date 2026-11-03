/**
 * Row access shared by world-local's storage: the event log and the
 * entities materialized from it, read and written inside the transaction
 * that `events.create` runs in (see `events-storage.ts`).
 *
 * Every function here is synchronous and is only correct inside
 * `Database.transact` (writes) or as a single read statement.
 */

import type {
  Event,
  Hook,
  PaginatedResponse,
  Step,
  Wait,
  WorkflowRun,
} from '@workflow/world';
import { eventIdToSlot, slotToEventId } from '@workflow/world';
import { decode, encode } from '../db/codec.js';
import type { Database } from '../db/index.js';

export interface RunRow {
  run: WorkflowRun;
  tag: string | null;
  seq: number;
  seqInBand: number;
}

/**
 * Tag visibility: a tagged World sees its own rows and untagged ones; an
 * untagged World sees only untagged rows. Same rule as earlier releases,
 * where a tagged file was `<id>.<tag>.json` and the untagged fallback
 * `<id>.json`.
 */
export function tagClause(column: string, tag: string | undefined): string {
  return tag === undefined
    ? `${column} IS NULL`
    : `(${column} IS NULL OR ${column} = ?)`;
}

export function tagParams(tag: string | undefined): string[] {
  return tag === undefined ? [] : [tag];
}

export class Store {
  readonly db: Database;
  readonly tag: string | undefined;

  constructor(db: Database, tag: string | undefined) {
    this.db = db;
    this.tag = tag;
  }

  // ---------------------------------------------------------------- runs

  getRun(runId: string): RunRow | null {
    const row = this.db.get<{
      doc: string;
      tag: string | null;
      seq: number;
      seq_in_band: number;
    }>(
      `SELECT doc, tag, seq, seq_in_band FROM runs WHERE run_id = ? AND ${tagClause('tag', this.tag)}`,
      runId,
      ...tagParams(this.tag)
    );
    if (!row) return null;
    return {
      run: decode<WorkflowRun>(row.doc),
      tag: row.tag,
      seq: Number(row.seq),
      seqInBand: Number(row.seq_in_band),
    };
  }

  /** A run regardless of tag: the owner of a hook token can be any run. */
  getRunAnyTag(runId: string): RunRow | null {
    const row = this.db.get<{
      doc: string;
      tag: string | null;
      seq: number;
      seq_in_band: number;
    }>('SELECT doc, tag, seq, seq_in_band FROM runs WHERE run_id = ?', runId);
    if (!row) return null;
    return {
      run: decode<WorkflowRun>(row.doc),
      tag: row.tag,
      seq: Number(row.seq),
      seqInBand: Number(row.seq_in_band),
    };
  }

  runExistsAnyTag(runId: string): boolean {
    return (
      this.db.get('SELECT 1 AS one FROM runs WHERE run_id = ?', runId) !==
      undefined
    );
  }

  insertRun(run: WorkflowRun): void {
    this.db.run(
      `INSERT INTO runs (run_id, tag, workflow_name, status, created_at, seq, seq_in_band, doc)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
      run.runId,
      this.tag ?? null,
      run.workflowName,
      run.status,
      run.createdAt.getTime(),
      encode(run)
    );
  }

  updateRun(run: WorkflowRun): void {
    this.db.run(
      'UPDATE runs SET status = ?, doc = ? WHERE run_id = ?',
      run.status,
      encode(run),
      run.runId
    );
  }

  advanceInBand(runId: string): void {
    this.db.run(
      'UPDATE runs SET seq_in_band = seq_in_band + 1 WHERE run_id = ?',
      runId
    );
  }

  // -------------------------------------------------------------- events

  /** The highest position in `runId`'s log, 0 when it has none. */
  topSeq(runId: string): number {
    const row = this.db.get<{ seq: number | null }>(
      'SELECT MAX(seq) AS seq FROM events WHERE run_id = ?',
      runId
    );
    return Number(row?.seq ?? 0);
  }

  /**
   * Appends `event` at the next position of its run's log and returns it with
   * its `eventId`. Positions are dense: nothing else writes this run's log
   * until the transaction commits.
   */
  appendEvent(event: Omit<Event, 'eventId'> & { eventId?: string }): Event {
    const seq = this.topSeq(event.runId) + 1;
    const stored = { ...event, eventId: slotToEventId(seq) } as Event;
    this.db.run(
      `INSERT INTO events (run_id, seq, event_type, correlation_id, doc)
       VALUES (?, ?, ?, ?, ?)`,
      stored.runId,
      seq,
      stored.eventType,
      (stored as { correlationId?: string }).correlationId ?? null,
      encode(stored)
    );
    this.db.run('UPDATE runs SET seq = ? WHERE run_id = ?', seq, stored.runId);
    return stored;
  }

  getEvent(runId: string, eventId: string): Event | null {
    const seq = eventIdToSlot(eventId);
    if (seq === null) return null;
    const row = this.db.get<{ doc: string }>(
      'SELECT doc FROM events WHERE run_id = ? AND seq = ?',
      runId,
      seq
    );
    return row ? decode<Event>(row.doc) : null;
  }

  getEventAt(runId: string, seq: number): Event | null {
    const row = this.db.get<{ doc: string }>(
      'SELECT doc FROM events WHERE run_id = ? AND seq = ?',
      runId,
      seq
    );
    return row ? decode<Event>(row.doc) : null;
  }

  findEvent(
    runId: string,
    correlationId: string,
    eventType: string
  ): Event | null {
    const row = this.db.get<{ doc: string }>(
      `SELECT doc FROM events WHERE run_id = ? AND correlation_id = ? AND event_type = ?
       ORDER BY seq LIMIT 1`,
      runId,
      correlationId,
      eventType
    );
    return row ? decode<Event>(row.doc) : null;
  }

  /**
   * A page of `runId`'s log in position order. The cursor is
   * `key:<eventId>` (exclusive), the format earlier releases used for
   * slot-numbered runs, so cursors a runtime holds stay valid.
   */
  listEvents(
    runId: string,
    options: {
      cursor?: string;
      limit?: number;
      sortOrder?: 'asc' | 'desc';
      correlationId?: string;
    }
  ): PaginatedResponse<Event> {
    const sortOrder = options.sortOrder ?? 'asc';
    const limit = Math.max(1, options.limit ?? 20);
    const after = parseEventCursor(options.cursor);
    const clauses = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (options.correlationId !== undefined) {
      clauses.push('correlation_id = ?');
      params.push(options.correlationId);
    }
    if (after !== null) {
      clauses.push(sortOrder === 'asc' ? 'seq > ?' : 'seq < ?');
      params.push(after);
    }
    const rows = this.db.all<{ doc: string }>(
      `SELECT doc FROM events WHERE ${clauses.join(' AND ')}
       ORDER BY seq ${sortOrder === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`,
      ...params,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
      decode<Event>(row.doc)
    );
    const last = data.at(-1);
    return {
      data,
      cursor: last ? eventCursor(last.eventId) : null,
      hasMore,
    };
  }

  /** Events strictly between two positions, in order. */
  eventsBetween(runId: string, afterSeq: number, beforeSeq: number): Event[] {
    return this.db
      .all<{ doc: string }>(
        'SELECT doc FROM events WHERE run_id = ? AND seq > ? AND seq < ? ORDER BY seq',
        runId,
        afterSeq,
        beforeSeq
      )
      .map((row) => decode<Event>(row.doc));
  }

  rewriteEvent(event: Event): void {
    const seq = eventIdToSlot(event.eventId);
    if (seq === null) return;
    this.db.run(
      'UPDATE events SET doc = ? WHERE run_id = ? AND seq = ?',
      encode(event),
      event.runId,
      seq
    );
  }

  // --------------------------------------------------------------- steps

  getStep(runId: string, stepId: string): Step | null {
    const row = this.db.get<{ doc: string }>(
      'SELECT doc FROM steps WHERE run_id = ? AND step_id = ?',
      runId,
      stepId
    );
    return row ? decode<Step>(row.doc) : null;
  }

  insertStep(step: Step): void {
    this.db.run(
      'INSERT INTO steps (run_id, step_id, created_at, doc) VALUES (?, ?, ?, ?)',
      step.runId,
      step.stepId,
      step.createdAt.getTime(),
      encode(step)
    );
  }

  updateStep(step: Step): void {
    this.db.run(
      'UPDATE steps SET doc = ? WHERE run_id = ? AND step_id = ?',
      encode(step),
      step.runId,
      step.stepId
    );
  }

  // --------------------------------------------------------------- waits

  getWait(runId: string, correlationId: string): Wait | null {
    const row = this.db.get<{ doc: string }>(
      'SELECT doc FROM waits WHERE run_id = ? AND wait_id = ?',
      runId,
      correlationId
    );
    return row ? decode<Wait>(row.doc) : null;
  }

  insertWait(correlationId: string, wait: Wait): void {
    this.db.run(
      'INSERT INTO waits (run_id, wait_id, doc) VALUES (?, ?, ?)',
      wait.runId,
      correlationId,
      encode(wait)
    );
  }

  updateWait(correlationId: string, wait: Wait): void {
    this.db.run(
      'UPDATE waits SET doc = ? WHERE run_id = ? AND wait_id = ?',
      encode(wait),
      wait.runId,
      correlationId
    );
  }

  // --------------------------------------------------------------- hooks

  getHook(hookId: string): Hook | null {
    const row = this.db.get<{ doc: string }>(
      'SELECT doc FROM hooks WHERE hook_id = ?',
      hookId
    );
    return row ? decode<Hook>(row.doc) : null;
  }

  upsertHook(hook: Hook): void {
    this.db.run(
      `INSERT INTO hooks (hook_id, run_id, token, tag, created_at, doc) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (hook_id) DO UPDATE SET run_id = excluded.run_id, token = excluded.token,
         tag = excluded.tag, created_at = excluded.created_at, doc = excluded.doc`,
      hook.hookId,
      hook.runId,
      hook.token,
      this.tag ?? null,
      hook.createdAt.getTime(),
      encode(hook)
    );
  }

  deleteHook(hookId: string): void {
    this.db.run('DELETE FROM hooks WHERE hook_id = ?', hookId);
  }

  getDisposal(hookId: string): {
    runId: string;
    forceClaimedBy?: { runId: string; hookId: string };
  } | null {
    const row = this.db.get<{
      run_id: string;
      force_claimed_by: string | null;
    }>(
      'SELECT run_id, force_claimed_by FROM hook_disposals WHERE hook_id = ?',
      hookId
    );
    if (!row) return null;
    return {
      runId: row.run_id,
      ...(row.force_claimed_by
        ? { forceClaimedBy: decode(row.force_claimed_by) }
        : {}),
    };
  }

  insertDisposal(
    hookId: string,
    runId: string,
    forceClaimedBy?: { runId: string; hookId: string }
  ): boolean {
    return (
      this.db.run(
        `INSERT INTO hook_disposals (hook_id, run_id, force_claimed_by) VALUES (?, ?, ?)
         ON CONFLICT (hook_id) DO NOTHING`,
        hookId,
        runId,
        forceClaimedBy ? encode(forceClaimedBy) : null
      ) > 0
    );
  }

  getTokenOwner(
    token: string
  ): { hookId: string; runId: string; retentionUntil: number | null } | null {
    const row = this.db.get<{
      hook_id: string;
      run_id: string;
      retention_until: number | null;
    }>(
      'SELECT hook_id, run_id, retention_until FROM hook_tokens WHERE token = ?',
      token
    );
    if (!row) return null;
    return {
      hookId: row.hook_id,
      runId: row.run_id,
      retentionUntil:
        row.retention_until === null ? null : Number(row.retention_until),
    };
  }

  setTokenOwner(
    token: string,
    hookId: string,
    runId: string,
    retentionUntil: Date | undefined
  ): void {
    this.db.run(
      `INSERT INTO hook_tokens (token, hook_id, run_id, retention_until) VALUES (?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET hook_id = excluded.hook_id, run_id = excluded.run_id,
         retention_until = excluded.retention_until`,
      token,
      hookId,
      runId,
      retentionUntil ? retentionUntil.getTime() : null
    );
  }

  /** Releases `token` only if `hookId` still holds it. */
  releaseToken(token: string, hookId: string): void {
    this.db.run(
      'DELETE FROM hook_tokens WHERE token = ? AND hook_id = ?',
      token,
      hookId
    );
  }
}

const EVENT_CURSOR_PREFIX = 'key:';

export function eventCursor(eventId: string): string {
  return `${EVENT_CURSOR_PREFIX}${eventId}`;
}

/**
 * The position an events cursor stands for. Accepts `key:<eventId>`, a bare
 * event id, and the `<iso>|<eventId>` form, whose id is used.
 */
export function parseEventCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  let id = cursor;
  if (id.startsWith(EVENT_CURSOR_PREFIX))
    id = id.slice(EVENT_CURSOR_PREFIX.length);
  else if (id.includes('|')) id = id.slice(id.indexOf('|') + 1);
  return eventIdToSlot(id);
}

/**
 * `(createdAt, id)` cursors, the format runs, steps and hooks have always
 * paged with: `<ISO time>|<id>`.
 */
export function entityCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

export function parseEntityCursor(
  cursor: string | undefined
): { timeMs: number; id: string | null } | null {
  if (!cursor) return null;
  const [time, id] = cursor.split('|');
  const timeMs = new Date(time).getTime();
  if (!Number.isFinite(timeMs)) return null;
  return { timeMs, id: id || null };
}

/** The `WHERE` fragment and params a `(created_at, id)` cursor adds. */
export function entityCursorClause(
  cursor: string | undefined,
  sortOrder: 'asc' | 'desc',
  timeColumn: string,
  idColumn: string
): { sql: string; params: unknown[] } | null {
  const parsed = parseEntityCursor(cursor);
  if (!parsed) return null;
  const op = sortOrder === 'asc' ? '>' : '<';
  if (parsed.id === null) {
    return { sql: `${timeColumn} ${op} ?`, params: [parsed.timeMs] };
  }
  return {
    sql: `(${timeColumn} ${op} ? OR (${timeColumn} = ? AND ${idColumn} ${op} ?))`,
    params: [parsed.timeMs, parsed.timeMs, parsed.id],
  };
}
