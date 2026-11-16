/**
 * Per-run usage (`world.experimental_usage`), counted from the run's rows
 * with aggregate queries. Nothing here decodes an event.
 *
 * Data written is what the run's rows hold in `world.db`: each event as
 * stored (its payloads included) and each stream chunk. A run started with
 * zero retention (`$retention: '0'`) has its payloads deleted when it
 * finishes; the purge saves the sizes first (`purged-usage.ts`), and those
 * are reported, plus anything written after. A run purged before the sizes
 * were saved reports what is left, marked as such.
 *
 * **Counted once, then extended.** node:sqlite is synchronous: while a read
 * runs, the process answers nothing else, and reading a run costs time in
 * proportion to its bytes (about 1.5 s for 210 MB). A run page polls its
 * usage every few seconds, so recounting a large live run on every poll
 * kept the web server blocked most of the time. So each World remembers
 * the counts of the runs it was asked about, up to the last log position
 * counted, and the next read adds only the rows after it:
 *
 * - Safe because a run's log is append-only: rows are added at the next
 *   position and never rewritten or removed, with one exception, the
 *   zero-retention purge, which rewrites every row in the transaction that
 *   finishes the run. Counts (types, steps) do not change in a purge, only
 *   bytes, and a purged run reports the sizes the purge saved, not the
 *   rows'. To stay exact anyway, counts taken before a run finished are
 *   dropped and taken again once it has finished with its data deleted
 *   (cheap then: the rows are small).
 * - A run that is not writing (sleeping, waiting on a hook) costs one
 *   lookup of its position. Stream bytes are summed fresh on every read
 *   (from the stream index, without reading the chunks' data).
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
  type RunUsageStepGroup,
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
 * The hooks and sleeps a range of positions names, for their span's call
 * counts (`calls`). Event type and correlation id are columns: no doc is
 * read.
 */
const HOOK_AND_WAIT_IDS_SQL = `
  SELECT DISTINCT correlation_id, substr(event_type, 1, 5) AS kind
  FROM events
  WHERE run_id = ?1 AND seq > ?2 AND seq <= ?3
    AND correlation_id IS NOT NULL
    AND (substr(event_type, 1, 5) = 'hook_' OR substr(event_type, 1, 5) = 'wait_')
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
 * Whether a finished run's data was deleted when it finished
 * (`withRunPayloadsPurged` stamps `expiredAt`). Only asked of a finished run
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
  hookIds: Set<string>;
  waitIds: Set<string>;
}

const newCounts = (): RunCounts => ({
  countedSeq: 0,
  finished: false,
  eventTypes: new Map(),
  steps: new Map(),
  hookIds: new Set(),
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
  for (const row of db.all<{ correlation_id: string; kind: string }>(
    HOOK_AND_WAIT_IDS_SQL,
    runId,
    from,
    to
  )) {
    (row.kind === 'hook_' ? counts.hookIds : counts.waitIds).add(
      row.correlation_id
    );
  }
  counts.countedSeq = to;
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
    group.bytes += step.bytes;
  }
  return [...byName.values()];
}

/**
 * Data written by a run whose data was deleted when it finished: what the
 * purge saved, plus what was written after it. Rows up to the saved position
 * are counted in the saved sizes and not again; the purge deleted the
 * stream chunks it measured, so the chunks there now came after it.
 */
function purgedDataWritten(
  db: Database,
  runId: string
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
    stream: saved.byEntity.stream + measureStreamBytes(db, runId),
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
  // Small first: rows can hold megabytes each.
  let batchRows = options.initialBatchRows ?? 4;

  // Per World (this closure), never module state. Insertion order is the
  // recency order: a read moves its run to the end.
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
      if (seq < counts.countedSeq) counts = newCounts();
      countRange(db, runId, counts, counts.countedSeq, seq);
      const savedDataWritten = purgedDataWritten(db, runId) ?? undefined;
      const dataPurged =
        savedDataWritten !== undefined ||
        (finished &&
          Number(db.get<{ purged: number }>(PURGED_RUN_SQL, runId)?.purged) ===
            1);
      // Counted (in part) before the purge rewrote the rows: count the
      // finished run again so the bytes are its rows as they are now.
      if (dataPurged && !counts.finished && counts.countedSeq > 0) {
        counts = newCounts();
        countRange(db, runId, counts, 0, seq);
      }
      counts.finished = finished;
      return {
        run,
        streamBytes: measureStreamBytes(db, runId),
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
      calls: { hook: counts.hookIds.size, wait: counts.waitIds.size },
      // Local runs are not billed: the UI and CLI say what the run would
      // count as on Vercel instead.
      billed: false,
      // world-local has no plan retention to multiply by.
      // TODO: confirm with the pricing owners that local runs hide it.
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
