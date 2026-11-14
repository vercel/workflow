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
 * zero retention (`$retention: '0'`) has had its payloads purged once it
 * finished, so it reports what is left.
 */

import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  buildRunUsage,
  type RunUsage,
  type RunUsageEventGroup,
  type RunUsageStepGroup,
  type WorkflowRunStatus,
} from '@workflow/world';
import type { Database } from '../db/index.js';
import { assertSafeEntityId } from '../ids.js';
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
         SUM(length(CAST(doc AS BLOB))) AS bytes
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
           SUM(length(CAST(doc AS BLOB))) AS bytes
    FROM events
    WHERE run_id = ?1 AND ${IS_STEP_EVENT}
    GROUP BY correlation_id
  ) AS e
  LEFT JOIN steps AS s ON s.run_id = ?1 AND s.step_id = e.correlation_id
  GROUP BY step_name
`;

const STREAM_BYTES_SQL = `
  SELECT COALESCE(SUM(length(data)), 0) AS bytes
  FROM stream_chunks
  WHERE run_id = ?
`;

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
        const streams = db.get<{ bytes: number }>(STREAM_BYTES_SQL, runId);
        return {
          run,
          events,
          steps,
          streamBytes: Number(streams?.bytes ?? 0),
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
        // world-local has no plan retention to multiply by.
        // TODO: confirm with the pricing owners that local runs hide it.
        dataRetained: null,
      });
    },
  };
}
