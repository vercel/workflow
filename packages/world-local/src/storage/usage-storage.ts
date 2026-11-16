/**
 * Per-run usage (`world.experimental_usage`), computed from aggregate
 * queries over the run's rows. Nothing here decodes an event: the log is
 * grouped and summed inside SQLite, which returns one row per event type
 * and one per step name, however long the log is. Measured on one devbox
 * core: 10,000 events with 2 KB payloads in under 200 ms; 3,000 events
 * holding 175 MB of payloads in about 1 s (reading the bytes dominates).
 *
 * Data written is what the run's rows hold in `world.db`: each event as
 * stored (its payloads included) and each stream chunk. A run started with
 * zero retention (`$retention: '0'`) has its payloads deleted when it
 * finishes; the purge saves the sizes first (`purged-usage.ts`), and those
 * are reported, plus anything written after. A run purged before the sizes
 * were saved reports what is left, marked as such.
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

/** A step event: `step_created`, `step_started`, ... */
const IS_STEP_EVENT = `event_type LIKE 'step\\_%' ESCAPE '\\'`;

/** Events other than a step's, grouped by type. */
const EVENT_GROUPS_SQL = `
  SELECT event_type,
         COUNT(*) AS events,
         SUM(${DOC_BYTES_SQL}) AS bytes
  FROM events
  WHERE run_id = ? AND NOT (${IS_STEP_EVENT})
  GROUP BY event_type
`;

/**
 * Step events grouped by step name, with a count per event type. The log is
 * grouped by step first, so each step's row is looked up (by primary key)
 * and its name extracted once per step, not once per event. The name comes
 * from the step's row because a spec 9 inline step has no `step_created`
 * event to carry it.
 *
 * The per-type counts are columns of the same pass over the step events:
 * a comparison per row on `event_type`, which the row already holds, so
 * they add no read of the events (whose rows carry the payloads).
 */
const STEP_GROUPS_SQL = `
  SELECT json_extract(s.doc, '$.stepName') AS step_name,
         COUNT(*) AS steps,
         SUM(e.events) AS events,
         SUM(e.created) AS created,
         SUM(e.started) AS started,
         SUM(e.completed) AS completed,
         SUM(e.failed) AS failed,
         SUM(e.retries) AS retries,
         SUM(e.bytes) AS bytes
  FROM (
    SELECT correlation_id,
           COUNT(*) AS events,
           SUM(event_type = 'step_created') AS created,
           SUM(event_type = 'step_started') AS started,
           SUM(event_type = 'step_completed') AS completed,
           SUM(event_type = 'step_failed') AS failed,
           SUM(event_type = 'step_retrying') AS retries,
           SUM(${DOC_BYTES_SQL}) AS bytes
    FROM events
    WHERE run_id = ?1 AND ${IS_STEP_EVENT}
    GROUP BY correlation_id
  ) AS e
  LEFT JOIN steps AS s ON s.run_id = ?1 AND s.step_id = e.correlation_id
  GROUP BY step_name
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

export function createUsageStorage(db: Database, tag?: string): UsageStorage {
  return {
    async getRun(runId: string): Promise<RunUsage> {
      assertSafeEntityId('runId', runId);
      // One read transaction: a run still executing commits between these
      // statements, and its status, events and streams must agree.
      const aggregates = db.snapshot(() => {
        const run = db.get<{ status: string; workflow_name: string }>(
          `SELECT status, workflow_name FROM runs WHERE run_id = ? AND ${tagClause('tag', tag)}`,
          runId,
          ...tagParams(tag)
        );
        if (!run) return null;
        const events = db.all<{
          event_type: string;
          events: number;
          bytes: number | null;
        }>(EVENT_GROUPS_SQL, runId);
        const steps = db.all<{
          step_name: string | null;
          steps: number;
          events: number;
          created: number;
          started: number;
          completed: number;
          failed: number;
          retries: number;
          bytes: number | null;
        }>(STEP_GROUPS_SQL, runId);
        const savedDataWritten = purgedDataWritten(db, runId) ?? undefined;
        const dataPurged =
          savedDataWritten !== undefined ||
          (isTerminalWorkflowRunStatus(run.status as WorkflowRunStatus) &&
            Number(
              db.get<{ purged: number }>(PURGED_RUN_SQL, runId)?.purged
            ) === 1);
        return {
          run,
          events,
          steps,
          streamBytes: measureStreamBytes(db, runId),
          dataPurged,
          savedDataWritten,
        };
      });
      if (!aggregates) throw new WorkflowRunNotFoundError(runId);
      return buildRunUsage({
        runId,
        status: aggregates.run.status as WorkflowRunStatus,
        workflowName: aggregates.run.workflow_name,
        eventGroups: aggregates.events.map(
          (row): RunUsageEventGroup => ({
            eventType: row.event_type,
            events: Number(row.events),
            bytes: Number(row.bytes ?? 0),
          })
        ),
        stepGroups: aggregates.steps.map(
          (row): RunUsageStepGroup => ({
            stepName: row.step_name,
            steps: Number(row.steps),
            events: Number(row.events),
            created: Number(row.created),
            started: Number(row.started),
            completed: Number(row.completed),
            failed: Number(row.failed),
            retries: Number(row.retries),
            bytes: Number(row.bytes ?? 0),
          })
        ),
        streamBytes: aggregates.streamBytes,
        dataPurged: aggregates.dataPurged,
        savedDataWritten: aggregates.savedDataWritten,
        // world-local has no plan retention to multiply by.
        // TODO: confirm with the pricing owners that local runs hide it.
        dataRetained: null,
      });
    },
  };
}
