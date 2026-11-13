import { TERMINAL_WORKFLOW_RUN_STATUSES } from '@workflow/world';
import type { Pool } from 'pg';

export const DEFAULT_RUN_QUEUE_SWEEP_INTERVAL_MS = 300_000;
export const DEFAULT_RUN_QUEUE_SWEEP_BATCH_SIZE = 500;
export const DEFAULT_SETTLED_RUN_SECONDS = 300;
const DRAIN_INTERVAL_MS = 2_000;
const LOCK_TIMEOUT_MS = 500;
const STATEMENT_TIMEOUT_MS = 2_000;
/** `lock_timeout`, `statement_timeout`, serialization failure, deadlock. */
const CONTENTION_ERROR_CODES = ['55P03', '57014', '40001', '40P01'];

const candidateRunQueuesSql = (
  schema: string
) => `SELECT job_queues.id, job_queues.queue_name
FROM ${schema}._private_job_queues AS job_queues
LEFT JOIN "workflow"."workflow_runs" AS runs
  ON runs.id = substring(
       job_queues.queue_name
       from length($1::text) + 1
       for greatest(
         length(job_queues.queue_name) - length($1::text) - length($2::text),
         0
       )
     )
WHERE job_queues.locked_at IS NULL
  AND length(job_queues.queue_name) > length($1::text) + length($2::text)
  AND left(job_queues.queue_name, length($1::text)) = $1::text
  AND right(job_queues.queue_name, length($2::text)) = $2::text
  AND (
    runs.id IS NULL
    OR (
      runs.status::text = ANY($3::text[])
      AND coalesce(runs.completed_at, runs.updated_at)
            < now() - make_interval(secs => $4::double precision)
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM ${schema}._private_jobs AS jobs
    WHERE jobs.job_queue_id = job_queues.id
  )
ORDER BY job_queues.id
LIMIT $5::int`;

/**
 * `graphile_worker.add_job` and `add_jobs` resolve a queue name to its row id
 * in the statement that inserts the job, and `_private_jobs.job_queue_id`
 * carries no foreign key, so a delete checked only against referencing jobs
 * can commit between a sender's read of the id and its insert, leaving a job
 * whose queue is gone — which `getJob` never admits again. Both functions
 * insert the queue name before they read its id, so every send of a
 * named-queue job holds `ROW EXCLUSIVE` on this table from before that read
 * until it commits: `EXCLUSIVE` therefore waits out every send already past
 * that point (whose job the re-check below then sees, in a fresh READ
 * COMMITTED snapshot) and holds off every later one, whose own insert
 * recreates the row. It asks nothing of the sender, so processes on any
 * version and other clients of the schema are equally covered.
 */
const lockRunQueueTableSql = (schema: string) =>
  `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'; SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'; LOCK TABLE ${schema}._private_job_queues IN EXCLUSIVE MODE`;

const deleteRunQueuesSql = (
  schema: string
) => `WITH referenced AS MATERIALIZED (
  SELECT DISTINCT jobs.job_queue_id
  FROM ${schema}._private_jobs AS jobs
  WHERE jobs.job_queue_id = ANY($1::int[])
)
DELETE FROM ${schema}._private_job_queues AS job_queues
WHERE job_queues.id = ANY($1::int[])
  AND job_queues.locked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM referenced WHERE referenced.job_queue_id = job_queues.id
  )
RETURNING job_queues.queue_name`;

export interface RunQueueReaperOptions {
  /** `<prefix><runId><suffix>` names a per-run queue of this World. */
  prefix: string;
  suffix: string;
  intervalMs?: number;
  batchSize?: number;
  settledSeconds?: number;
  random?: () => number;
}

export interface RunQueueReaper {
  sweepOnce(): Promise<string[]>;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Reclaim the Graphile named queue of a run that can no longer be sent to: one
 * whose run is gone from `workflow.workflow_runs`, or has been terminal for
 * `settledSeconds`, and which holds no job and is not locked.
 *
 * A single-orchestrator run (spec >= 9) and an invoke executor lane serialize
 * their deliveries through a queue named after the run (see
 * `executorQueueName`), and graphile-worker never deletes a queue row, so
 * without this one row per run accumulates for the lifetime of the database,
 * on a table every job fetch reads.
 */
export function createRunQueueReaper(
  pool: Pool,
  {
    prefix,
    suffix,
    intervalMs = DEFAULT_RUN_QUEUE_SWEEP_INTERVAL_MS,
    batchSize = DEFAULT_RUN_QUEUE_SWEEP_BATCH_SIZE,
    settledSeconds = DEFAULT_SETTLED_RUN_SECONDS,
    random = Math.random,
  }: RunQueueReaperOptions
): RunQueueReaper {
  // The schema Graphile Worker itself resolves when no `schema` option is
  // passed, which this World never passes.
  const schema = escapeIdentifier(
    process.env.GRAPHILE_WORKER_SCHEMA || 'graphile_worker'
  );
  const candidateQuery = candidateRunQueuesSql(schema);
  const lockQuery = lockRunQueueTableSql(schema);
  const deleteQuery = deleteRunQueuesSql(schema);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let sweeping: Promise<unknown> | undefined;
  let stopped = false;
  let failing = false;

  async function sweepOnce(): Promise<string[]> {
    const { rows } = await pool.query<{ id: number | string }>(candidateQuery, [
      prefix,
      suffix,
      [...TERMINAL_WORKFLOW_RUN_STATUSES],
      settledSeconds,
      batchSize,
    ]);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => Number(row.id));
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(lockQuery);
      const deleted = await client.query<{ queue_name: string }>(deleteQuery, [
        ids,
      ]);
      await client.query('COMMIT');
      return deleted.rows.map((row) => row.queue_name);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function sweep(): Promise<number> {
    try {
      const reclaimed = await sweepOnce();
      failing = false;
      return reclaimed.length >= batchSize
        ? DRAIN_INTERVAL_MS
        : jitter(intervalMs);
    } catch (error) {
      if (!isContention(error) && !failing) {
        failing = true;
        warn(
          '[world-postgres] Failed to reclaim the Graphile queues of settled runs; retrying:',
          error
        );
      }
      return jitter(intervalMs);
    }
  }

  function jitter(delayMs: number): number {
    return delayMs * (0.8 + 0.4 * random());
  }

  function schedule(delayMs: number) {
    if (stopped || timer || sweeping) return;
    timer = setTimeout(() => {
      timer = undefined;
      let nextDelayMs = jitter(intervalMs);
      sweeping = sweep()
        .then((delay) => {
          nextDelayMs = delay;
        })
        .finally(() => {
          sweeping = undefined;
          schedule(nextDelayMs);
        });
    }, delayMs);
    timer.unref?.();
  }

  return {
    sweepOnce,
    start() {
      if (stopped) return;
      schedule(jitter(intervalMs));
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      await sweeping;
    },
  };
}

function isContention(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && CONTENTION_ERROR_CODES.includes(code);
}

/** Quote an SQL identifier, as `pg`'s `escapeIdentifier` does. */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * `console.warn`, except in the CLI's JSON mode (`WORKFLOW_JSON_MODE=1`),
 * whose output must stay machine-readable.
 */
function warn(...args: unknown[]): void {
  if (process.env.WORKFLOW_JSON_MODE === '1') return;
  console.warn(...args);
}
