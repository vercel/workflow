import type { Pool } from 'pg';

/**
 * Removes the Graphile named queues that earlier versions created per run.
 *
 * Before run leases (`run-lease.ts`), a spec 9 run's orchestrator deliveries,
 * and invoke mode's executor lane, ran in a Graphile named queue per run,
 * `<task>:<runId>` or `<task>:<runId>:executor`, where `<task>` is this
 * World's task (`<jobPrefix>flows`, or `<jobPrefix><deploymentId>_flows` for
 * a pinned deployment). Graphile Worker never deletes a named queue's row, so
 * those versions left one row per run in `_private_job_queues` for good
 * (https://github.com/vercel/workflow/issues/5378), and Graphile's `get_job`
 * locks every available queue row on each poll, so every poll got slower as
 * runs accumulated. This version adds no job to a named queue; this removes
 * the rows earlier versions left.
 *
 * A row is removed only while it is unlocked and no job is in its queue. It
 * is removed in batches, skipping rows another session has locked (a
 * `get_job` that is about to lock the queue), so the removal never waits on
 * Graphile Worker, and only an `add_job` for one of the queues being removed
 * waits, for that one batch. A process on an earlier version that
 * still adds jobs to per-run queues during a rolling upgrade recreates the
 * row when it adds one.
 *
 * One interleaving cannot be fenced without locking the whole table:
 * Graphile's `add_job` first ensures the queue row exists, without locking
 * it, then inserts the job with that row's id (there is no foreign key). A
 * removal that does not see that job yet (it commits after the removal read
 * the queue as empty) leaves the job naming a queue that no longer exists,
 * and `get_job` never picks up such a job. The reclaim
 * therefore also moves this World's jobs whose queue no longer exists out of
 * it (`job_queue_id = NULL`): on a process's first reclaim, and on its next
 * {@link REPAIRS_AFTER_REMOVAL} after any that removed a row, so a job left
 * that way by this process waits at most until one of them (a job left by a
 * process that then exited waits for the next process to start). That
 * statement reads every job of this World that is in a named queue, so it is
 * not run on every reclaim once nothing is being removed. Such a job then runs
 * outside a named queue, as this version's jobs all do; a process on an
 * earlier version that picks up an executor job outside its run's queue
 * transfers it back to that queue, as it does for any job it finds there.
 *
 * Reads Graphile Worker's internal tables, as `job-lease.ts` does, which is
 * why `package.json` pins graphile-worker exactly.
 */
export interface LegacyJobQueues {
  /**
   * Removes up to `maxBatches` batches of empty per-run queues, then moves
   * jobs whose queue no longer exists out of it. Returns how many of each.
   * `stopping` ends the removal between batches (the queue is closing).
   */
  reclaim(stopping?: () => boolean): Promise<{ queues: number; jobs: number }>;
}

/**
 * What follows the job prefix in this World's task identifiers and per-run
 * queue names: an optional pinned deployment id (`<deploymentId>_`, see
 * `resolveJobPrefix`), then `flows`. A deployment id is
 * `[A-Za-z0-9._@-]+`.
 */
const TASK_SUFFIX = '([A-Za-z0-9._@-]+_)?flows';
/** A per-run queue name after the prefix: `<task>:<runId>[:executor]`. */
const PER_RUN_QUEUE = `^${TASK_SUFFIX}:wrun_[^:]+(:executor)?$`;
/** A task identifier after the prefix: `<task>` or `<task>_executor`. */
const TASK = `^${TASK_SUFFIX}(_executor)?$`;

// The prefix is compared with `starts_with` and the rest with a pattern, so
// a job prefix needs no escaping.
const removeSql = (schema: string) => `WITH empty_queues AS (
  SELECT job_queues.id
  FROM ${schema}._private_job_queues AS job_queues
  WHERE starts_with(job_queues.queue_name, $1::text)
    AND substr(job_queues.queue_name, length($1::text) + 1) ~ '${PER_RUN_QUEUE}'
    AND job_queues.locked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM ${schema}._private_jobs AS jobs
      WHERE jobs.job_queue_id = job_queues.id
    )
  LIMIT $2::int
  FOR UPDATE OF job_queues SKIP LOCKED
)
DELETE FROM ${schema}._private_job_queues AS job_queues
USING empty_queues
WHERE job_queues.id = empty_queues.id
  AND job_queues.locked_at IS NULL
RETURNING job_queues.id`;

const repairSql = (schema: string) => `UPDATE ${schema}._private_jobs AS jobs
SET job_queue_id = NULL
FROM ${schema}._private_tasks AS tasks
WHERE tasks.id = jobs.task_id
  AND starts_with(tasks.identifier, $1::text)
  AND substr(tasks.identifier, length($1::text) + 1) ~ '${TASK}'
  AND jobs.job_queue_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ${schema}._private_job_queues AS job_queues
    WHERE job_queues.id = jobs.job_queue_id
  )
RETURNING jobs.id`;

/** Queue rows one statement removes. */
export const DEFAULT_RECLAIM_BATCH_SIZE = 1_000;
/** Statements one `reclaim()` runs at most, so a large backlog is spread out. */
export const DEFAULT_RECLAIM_MAX_BATCHES = 20;
/**
 * Reclaims after one that removed a queue row that also repair jobs left
 * naming a removed queue: the job whose `add_job` raced a removal commits
 * when that `add_job` does, after the removal.
 */
export const REPAIRS_AFTER_REMOVAL = 5;

export function createLegacyJobQueues(
  pool: Pool,
  {
    jobPrefix,
    batchSize = DEFAULT_RECLAIM_BATCH_SIZE,
    maxBatches = DEFAULT_RECLAIM_MAX_BATCHES,
  }: {
    /** This World's job prefix without a deployment id (`resolveJobPrefix`). */
    jobPrefix: string;
    batchSize?: number;
    maxBatches?: number;
  }
): LegacyJobQueues {
  // The schema Graphile Worker itself resolves when no `schema` option is
  // passed, which this World never passes.
  const schema = escapeIdentifier(
    process.env.GRAPHILE_WORKER_SCHEMA || 'graphile_worker'
  );
  const removeQuery = removeSql(schema);
  const repairQuery = repairSql(schema);
  // The first reclaim repairs: a process that removed rows may have exited
  // before its own repairs ran.
  let repairsOwed = 1;

  return {
    async reclaim(stopping = () => false) {
      let queues = 0;
      for (let batch = 0; batch < maxBatches && !stopping(); batch++) {
        const removed =
          (await pool.query(removeQuery, [jobPrefix, batchSize])).rowCount ?? 0;
        queues += removed;
        // This reclaim's repair, and the next ones'.
        if (removed > 0) repairsOwed = REPAIRS_AFTER_REMOVAL + 1;
        if (removed < batchSize) break;
      }
      if (repairsOwed === 0) return { queues, jobs: 0 };
      const jobs = (await pool.query(repairQuery, [jobPrefix])).rowCount ?? 0;
      repairsOwed--;
      return { queues, jobs };
    },
  };
}

/** Quote an SQL identifier, as `pg`'s `escapeIdentifier` does. */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
