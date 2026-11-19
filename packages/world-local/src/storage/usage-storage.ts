/**
 * Per-run usage (`world.experimental_usage`), counted from the run's rows
 * with aggregate queries. Nothing here decodes an event.
 *
 * Data written is what the run's rows hold in `world.db`: each event as
 * stored (its payloads included) and each stream chunk. A run started with
 * zero retention (`$retention: '0'`) has its payloads deleted when it
 * finishes, and any finished run's can be deleted on demand; the purge saves
 * the sizes first (`purged-usage.ts`), and those are reported, plus anything
 * written after. A run deleted before the sizes were saved reports what is
 * left, marked as such.
 *
 * **Counted once, then extended.** node:sqlite is synchronous: while a read
 * runs, the process answers nothing else, and reading a run costs time in
 * proportion to its bytes (about 1.5 s for 210 MB). A UI that polls a live
 * run's usage every few seconds would keep its server blocked most of the
 * time if every poll recounted the run. So each World remembers
 * the counts of the runs it was asked about, up to the last log position
 * counted, and the next read adds only the rows after it:
 *
 * - Safe because a run's log is append-only: rows are added at the next
 *   position and never rewritten or removed, with one exception, the
 *   deletion of a run's data, which rewrites rows in place: every row when a
 *   zero-retention run finishes or a finished run's data is deleted on
 *   demand (`purgeRunData`), and one row when a late step write lands on a
 *   deleted run (`purgeLateStepWrite`). Counts (types, steps) do not change,
 *   only bytes, and a run whose data was deleted reports the sizes saved
 *   before each rewrite, not its rows'. To stay exact anyway, counts taken
 *   before a run finished are dropped and taken again once it has finished
 *   with its data deleted (cheap then: the rows are small).
 * - A run that is not writing (sleeping, waiting on a hook) costs one
 *   lookup of its position for its events. Its stream bytes are summed on
 *   every read, one pass over the lengths of its chunks: a run with many
 *   chunks costs time in proportion to their count (tens of
 *   milliseconds for 60,000). Not cached: chunks are keyed by stream and index, and a purge
 *   deletes them, so a running total would need the same pass to check.
 * - The first count of a run is split into batches of a few milliseconds
 *   each, yielding between them, so even that read leaves the process free
 *   to answer other requests. Rows up to the position the batches stop at
 *   cannot change while they run (the purge aside, handled above), so the
 *   batches need no shared read transaction; the last batch, the run's
 *   status and everything else is read in one, so the result is one
 *   consistent view of the run.
 *
 * The counts live on this World's storage (the closure below), not in
 * module state, and are bounded: the least recently read runs are dropped.
 */

import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  buildRunUsage,
  isTerminalWorkflowRunStatus,
  type RunUsage,
  type RunUsageEntity,
  type RunUsageEventGroup,
  type RunUsageHookGroup,
  type RunUsageStepGroup,
  startHookId,
  type WorkflowRunStatus,
} from '@workflow/world';
import type { Database } from '../db/index.js';
import { assertSafeEntityId } from '../ids.js';
import {
  DOC_BYTES_SQL,
  EntityBytes,
  measureStreamBytes,
  readPurgedUsage,
} from './purged-usage.js';
import { tagClause, tagParams } from './store.js';

export interface UsageStorage {
  getRun(runId: string): Promise<RunUsage>;
}

export interface UsageStorageOptions {
  /** Runs whose counts are kept (least recently read dropped first). */
  maxRuns?: number;
  /** How long one batch of the first count aims to take. */
  batchTargetMs?: number;
  /** First batch size, in rows (tests force many small batches). */
  initialBatchRows?: number;
  /** Largest batch, in rows. */
  maxBatchRows?: number;
  /** Called between batches (tests write to the run there). */
  onBatch?: (runId: string, countedSeq: number) => void | Promise<void>;
  /** Called when a read recounts a run whose data was deleted (tests). */
  onRecount?: (runId: string) => void;
}

/** A step event: `step_created`, `step_started`, ... */
const IS_STEP_EVENT = `event_type LIKE 'step\\_%' ESCAPE '\\'`;

/** Events other than a step's in a range of positions, grouped by type. */
const EVENT_GROUPS_SQL = `
  SELECT event_type,
         COUNT(*) AS events,
         SUM(${DOC_BYTES_SQL}) AS bytes
  FROM events
  WHERE run_id = ?1 AND seq > ?2 AND seq <= ?3 AND NOT (${IS_STEP_EVENT})
  GROUP BY event_type
`;

/**
 * Step events in a range of positions, grouped by step, with a count per
 * event type. The per-type counts are columns of the same pass over the
 * rows: a comparison per row on `event_type`, which the row already holds.
 */
const STEP_GROUPS_SQL = `
  SELECT correlation_id,
         COUNT(*) AS events,
         SUM(event_type = 'step_created') AS created,
         SUM(event_type = 'step_started') AS started,
         SUM(event_type = 'step_completed') AS completed,
         SUM(event_type = 'step_failed') AS failed,
         SUM(event_type = 'step_retrying') AS retries,
         SUM(${DOC_BYTES_SQL}) AS bytes
  FROM events
  WHERE run_id = ?1 AND seq > ?2 AND seq <= ?3 AND ${IS_STEP_EVENT}
  GROUP BY correlation_id
`;

/**
 * The sleeps a range of positions names, for their span's call count.
 * Event type and correlation id are columns: no doc is read.
 */
const WAIT_IDS_SQL = `
  SELECT DISTINCT correlation_id
  FROM events
  WHERE run_id = ?1 AND seq > ?2 AND seq <= ?3
    AND correlation_id IS NOT NULL AND substr(event_type, 1, 5) = 'wait_'
`;

/** Hook events in a range of positions, by hook. No doc is read. */
const HOOK_GROUPS_SQL = `
  SELECT correlation_id, COUNT(*) AS events
  FROM events
  WHERE run_id = ?1 AND seq > ?2 AND seq <= ?3
    AND correlation_id IS NOT NULL AND substr(event_type, 1, 5) = 'hook_'
  GROUP BY correlation_id
`;

/**
 * A hook's token, from the event that created it (or the one that reported
 * its token taken). Looked up once per hook; a purge keeps the token.
 */
const HOOK_TOKEN_SQL = `
  SELECT json_extract(doc, '$.eventData.token') AS token
  FROM events
  WHERE run_id = ? AND correlation_id = ?
    AND event_type IN ('hook_created', 'hook_conflict')
  ORDER BY seq LIMIT 1
`;

/** A hook's token from its row, for a hook with no creating event. */
const HOOK_ROW_TOKEN_SQL = 'SELECT token FROM hooks WHERE hook_id = ?';

/**
 * A run's start Hook is created with the run (`run_created`'s `startHook`),
 * not by a `hook_created` event, and its row goes when the run finishes.
 */
const START_HOOK_TOKEN_SQL = `
  SELECT json_extract(doc, '$.eventData.startHook.token') AS token
  FROM events
  WHERE run_id = ? AND event_type = 'run_created'
  LIMIT 1
`;

/**
 * A step's name, from its row: a spec 9 inline step has no `step_created`
 * event to carry it. Looked up once per step.
 */
const STEP_NAME_SQL = `
  SELECT json_extract(doc, '$.stepName') AS step_name
  FROM steps WHERE run_id = ? AND step_id = ?
`;

/** The position `count` rows past `afterSeq` (or the last one). */
const BATCH_END_SQL = `
  SELECT MAX(seq) AS seq FROM (
    SELECT seq FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?
  )
`;

/** Events written after a log position, by type: a purged run's late writes. */
const EVENTS_AFTER_SQL = `
  SELECT event_type, SUM(${DOC_BYTES_SQL}) AS bytes
  FROM events
  WHERE run_id = ? AND seq > ?
  GROUP BY event_type
`;

/**
 * Whether a finished run's data was deleted, when it finished or on demand
 * (`withRunPayloadsPurged` stamps `expiredAt`; world-local stamps it only
 * when it deletes). Only asked of a finished run
 * with no saved sizes: the doc is parsed, so a running run skips it.
 */
const PURGED_RUN_SQL = `
  SELECT json_extract(doc, '$.expiredAt') IS NOT NULL AS purged
  FROM runs WHERE run_id = ?
`;

interface StepCount {
  name: string | null;
  events: number;
  created: number;
  started: number;
  completed: number;
  failed: number;
  retries: number;
  bytes: number;
}

/** One run's counts, up to `countedSeq`. */
interface RunCounts {
  countedSeq: number;
  /** The run was finished when these counts were last extended. */
  finished: boolean;
  eventTypes: Map<string, { events: number; bytes: number }>;
  /** By step id. */
  steps: Map<string, StepCount>;
  /** By hook id. */
  hooks: Map<string, { token: string | null; events: number }>;
  waitIds: Set<string>;
}

const newCounts = (): RunCounts => ({
  countedSeq: 0,
  finished: false,
  eventTypes: new Map(),
  steps: new Map(),
  hooks: new Map(),
  waitIds: new Set(),
});

/** Adds the rows in `(from, to]` to `counts`. One statement each: atomic. */
function countRange(
  db: Database,
  runId: string,
  counts: RunCounts,
  from: number,
  to: number
): void {
  if (to <= from) return;
  for (const row of db.all<{
    event_type: string;
    events: number;
    bytes: number | null;
  }>(EVENT_GROUPS_SQL, runId, from, to)) {
    const entry = counts.eventTypes.get(row.event_type) ?? {
      events: 0,
      bytes: 0,
    };
    entry.events += Number(row.events);
    entry.bytes += Number(row.bytes ?? 0);
    counts.eventTypes.set(row.event_type, entry);
  }
  for (const row of db.all<{
    correlation_id: string | null;
    events: number;
    created: number;
    started: number;
    completed: number;
    failed: number;
    retries: number;
    bytes: number | null;
  }>(STEP_GROUPS_SQL, runId, from, to)) {
    const stepId = row.correlation_id ?? '';
    let step = counts.steps.get(stepId);
    if (!step) {
      const name =
        row.correlation_id === null
          ? null
          : (db.get<{ step_name: string | null }>(
              STEP_NAME_SQL,
              runId,
              row.correlation_id
            )?.step_name ?? null);
      step = {
        name,
        events: 0,
        created: 0,
        started: 0,
        completed: 0,
        failed: 0,
        retries: 0,
        bytes: 0,
      };
      counts.steps.set(stepId, step);
    }
    step.events += Number(row.events);
    step.created += Number(row.created);
    step.started += Number(row.started);
    step.completed += Number(row.completed);
    step.failed += Number(row.failed);
    step.retries += Number(row.retries);
    step.bytes += Number(row.bytes ?? 0);
  }
  for (const row of db.all<{ correlation_id: string; events: number }>(
    HOOK_GROUPS_SQL,
    runId,
    from,
    to
  )) {
    let hook = counts.hooks.get(row.correlation_id);
    if (!hook) {
      hook = { token: hookToken(db, runId, row.correlation_id), events: 0 };
      counts.hooks.set(row.correlation_id, hook);
    }
    hook.events += Number(row.events);
  }
  for (const row of db.all<{ correlation_id: string }>(
    WAIT_IDS_SQL,
    runId,
    from,
    to
  )) {
    counts.waitIds.add(row.correlation_id);
  }
  counts.countedSeq = to;
}

function hookToken(db: Database, runId: string, hookId: string): string | null {
  const created = db.get<{ token: unknown }>(HOOK_TOKEN_SQL, runId, hookId);
  if (typeof created?.token === 'string' && created.token) return created.token;
  const row = db.get<{ token: unknown }>(HOOK_ROW_TOKEN_SQL, hookId);
  if (typeof row?.token === 'string' && row.token) return row.token;
  let startHook: string | undefined;
  try {
    startHook = startHookId(runId);
  } catch {
    return null;
  }
  if (hookId !== startHook) return null;
  const start = db.get<{ token: unknown }>(START_HOOK_TOKEN_SQL, runId);
  return typeof start?.token === 'string' && start.token ? start.token : null;
}

function hookGroupsOf(counts: RunCounts): RunUsageHookGroup[] {
  return [...counts.hooks].map(([hookId, hook]) => ({
    hookId,
    token: hook.token,
    events: hook.events,
  }));
}

function eventGroupsOf(counts: RunCounts): RunUsageEventGroup[] {
  return [...counts.eventTypes].map(([eventType, entry]) => ({
    eventType,
    events: entry.events,
    bytes: entry.bytes,
  }));
}

function stepGroupsOf(counts: RunCounts): RunUsageStepGroup[] {
  const byName = new Map<string | null, RunUsageStepGroup>();
  for (const step of counts.steps.values()) {
    let group = byName.get(step.name);
    if (!group) {
      group = {
        stepName: step.name,
        steps: 0,
        events: 0,
        created: 0,
        started: 0,
        completed: 0,
        failed: 0,
        retries: 0,
        restarts: 0,
        bytes: 0,
      };
      byName.set(step.name, group);
    }
    group.steps += 1;
    group.events += step.events;
    group.created += step.created;
    group.started += step.started;
    group.completed += step.completed;
    group.failed += step.failed;
    group.retries += step.retries;
    // The starts a retry caused: each one after the step's first, up to its
    // retry markers. A start past those is a redelivery, not a retry.
    group.restarts += Math.min(step.retries, Math.max(0, step.started - 1));
    group.bytes += step.bytes;
  }
  return [...byName.values()];
}

/**
 * Data written by a run whose data was deleted: what the
 * purge saved, plus what was written after it. Rows up to the saved position
 * are counted in the saved sizes and not again; the purge deleted the
 * stream chunks it measured, so the chunks there now came after it.
 */
function purgedDataWritten(
  db: Database,
  runId: string,
  streamBytes: number
): Record<RunUsageEntity, number> | null {
  const saved = readPurgedUsage(db, runId);
  if (!saved) return null;
  const late = new EntityBytes();
  for (const row of db.all<{ event_type: string; bytes: number | null }>(
    EVENTS_AFTER_SQL,
    runId,
    saved.seq
  )) {
    late.add(row.event_type, Number(row.bytes ?? 0));
  }
  return {
    run: saved.byEntity.run + late.byEntity.run,
    step: saved.byEntity.step + late.byEntity.step,
    hook: saved.byEntity.hook + late.byEntity.hook,
    stream: saved.byEntity.stream + streamBytes,
  };
}

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export function createUsageStorage(
  db: Database,
  tag?: string,
  options: UsageStorageOptions = {}
): UsageStorage {
  const maxRuns = options.maxRuns ?? 64;
  const batchTargetMs = options.batchTargetMs ?? 10;
  const maxBatchRows = options.maxBatchRows ?? 4096;
  // Each counting pass starts small (rows can hold megabytes each) and
  // tunes its batch to the rows it reads. A size learned on one run is never
  // used for another: a run of small rows grows the batch to thousands, and
  // a run of large rows read next would count in one block.
  const initialBatchRows = options.initialBatchRows ?? 4;

  // Per World (this closure), never module state. Insertion order is the
  // recency order: a read moves its run to the end.
  //
  // A read counts only the rows after the last position it counted, so the
  // cache assumes event rows are never rewritten in place. The paths that do
  // are the deletions of a run's data in run-retention.ts: `purgeRunData`
  // (a zero-retention run's finish, or `runs.deleteDataMany`) and
  // `purgeLateStepWrite` (a late step write on a deleted run). Each saves
  // the run's sizes before rewriting, and the read reports those; counts
  // taken before the run finished are taken again.
  const cache = new Map<string, RunCounts>();
  // One count per run at a time: a second read of the same run waits for
  // the first and extends what it counted. Overlapping counts would still be
  // right (each batch reads and advances the counted position in one
  // synchronous step), but each would block the process for the whole run.
  const inFlight = new Map<string, Promise<unknown>>();

  const remember = (runId: string, counts: RunCounts) => {
    cache.delete(runId);
    cache.set(runId, counts);
    while (cache.size > maxRuns) {
      cache.delete(cache.keys().next().value as string);
    }
  };

  const runRow = (runId: string) =>
    db.get<{ status: string; workflow_name: string; seq: number }>(
      `SELECT status, workflow_name, seq FROM runs WHERE run_id = ? AND ${tagClause('tag', tag)}`,
      runId,
      ...tagParams(tag)
    );

  /** Counts up to `target` in batches, yielding between them. */
  async function countInBatches(
    runId: string,
    counts: RunCounts,
    target: number
  ): Promise<void> {
    let batchRows = initialBatchRows;
    while (counts.countedSeq < target) {
      const end = Number(
        db.get<{ seq: number | null }>(
          BATCH_END_SQL,
          runId,
          counts.countedSeq,
          batchRows
        )?.seq ?? target
      );
      const started = performance.now();
      countRange(db, runId, counts, counts.countedSeq, Math.min(end, target));
      const took = performance.now() - started;
      // Rows vary in size, so the batch follows the time each one took: it
      // shrinks at once, and grows at most twofold, so a run of small rows
      // cannot size a batch that lands on large ones.
      batchRows = Math.max(
        1,
        Math.min(
          maxBatchRows,
          batchRows * 2,
          Math.round((batchRows * batchTargetMs) / Math.max(took, 0.1))
        )
      );
      if (counts.countedSeq < target) {
        await options.onBatch?.(runId, counts.countedSeq);
        await yieldToEventLoop();
      }
    }
  }

  async function read(runId: string): Promise<RunUsage> {
    const first = runRow(runId);
    if (!first) {
      cache.delete(runId);
      throw new WorkflowRunNotFoundError(runId);
    }
    let counts = cache.get(runId) ?? newCounts();
    // A database replaced underneath (positions went back): count afresh.
    if (Number(first.seq) < counts.countedSeq) counts = newCounts();
    // Whether any row counted here may have been read before the run
    // finished, and so before a zero-retention purge rewrote it: rows
    // cached from a read of the running run, or rows this read's batches
    // count while it is still running. A run that had finished when this
    // read began was already purged, so its rows are read as they are.
    let readBeforeFinish =
      !isTerminalWorkflowRunStatus(first.status as WorkflowRunStatus) ||
      (counts.countedSeq > 0 && !counts.finished);
    await countInBatches(runId, counts, Number(first.seq));

    // The rest in one read transaction: the run's status, the rows written
    // since the batches (usually none), its streams and purge state agree.
    const snapshot = db.snapshot(() => {
      const run = runRow(runId);
      if (!run) return null;
      const seq = Number(run.seq);
      const finished = isTerminalWorkflowRunStatus(
        run.status as WorkflowRunStatus
      );
      if (seq < counts.countedSeq) {
        counts = newCounts();
        // Counted below, inside this read of the finished run.
        readBeforeFinish = !finished;
      }
      countRange(db, runId, counts, counts.countedSeq, seq);
      // Summed once, for the run's streams and a purged run's late ones.
      const streamBytes = measureStreamBytes(db, runId);
      const savedDataWritten =
        purgedDataWritten(db, runId, streamBytes) ?? undefined;
      const dataPurged =
        savedDataWritten !== undefined ||
        (finished &&
          Number(db.get<{ purged: number }>(PURGED_RUN_SQL, runId)?.purged) ===
            1);
      // Counted (in part) before the purge rewrote the rows: count the
      // finished run again so the bytes are its rows as they are now. Not on
      // a first read of a run that had already finished: every row was read
      // after its purge, and this recount is one unbatched block.
      if (dataPurged && readBeforeFinish && counts.countedSeq > 0) {
        options.onRecount?.(runId);
        counts = newCounts();
        countRange(db, runId, counts, 0, seq);
      }
      counts.finished = finished;
      return {
        run,
        streamBytes,
        dataPurged,
        savedDataWritten,
      };
    });
    if (!snapshot) {
      cache.delete(runId);
      throw new WorkflowRunNotFoundError(runId);
    }
    remember(runId, counts);
    return buildRunUsage({
      runId,
      status: snapshot.run.status as WorkflowRunStatus,
      workflowName: snapshot.run.workflow_name,
      eventGroups: eventGroupsOf(counts),
      stepGroups: stepGroupsOf(counts),
      streamBytes: snapshot.streamBytes,
      dataPurged: snapshot.dataPurged,
      savedDataWritten: snapshot.savedDataWritten,
      hookGroups: hookGroupsOf(counts),
      calls: { wait: counts.waitIds.size },
      // Local runs are not billed.
      billed: false,
      // world-local has no plan retention, so there is no Data Retained to
      // report: the UI and CLI hide it.
      dataRetained: null,
    });
  }

  return {
    async getRun(runId: string): Promise<RunUsage> {
      assertSafeEntityId('runId', runId);
      const previous = inFlight.get(runId) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(() => read(runId));
      inFlight.set(runId, current);
      try {
        return await current;
      } finally {
        if (inFlight.get(runId) === current) inFlight.delete(runId);
      }
    },
  };
}
