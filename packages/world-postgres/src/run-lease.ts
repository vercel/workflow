import type { Pool } from 'pg';

/**
 * Per-run delivery leases: what serializes a spec 9 run's orchestrator
 * deliveries (and invoke mode's executor deliveries) across every worker and
 * process sharing the database. See "Serializing a run's deliveries" in
 * `HOW_IT_WORKS.md` for the design.
 *
 * A run has a row in `workflow.workflow_run_delivery_leases` only while a
 * delivery drives it. The row names the Graphile job that owns it. The lease
 * is live while that job exists and can still run: locked, or unlocked with
 * attempts left (a crashed holder whose lock was released, or a handoff's
 * continuation waiting to start). So a crashed holder's redelivery, which is
 * the same job, takes its lease back, and no separate expiry is needed.
 *
 * A delivery that finds the lease live leaves its message on the row for the
 * owner and completes:
 *
 * - `wake`: one orchestrator message any later delivery of the run covers,
 *   because its producer committed what it is for before sending it. The owner
 *   re-runs for it in place (coalescing). Later wakes are dropped, except that
 *   a wake carrying a hook resume's timing replaces one without.
 * - `deferred`: every message a later delivery does not cover (a start
 *   message carrying the run's input, a hook's input, invoke mode's executor
 *   deliveries). The owner re-adds them as jobs when it releases.
 *
 * Releasing deletes the row and re-adds what was left on it in one
 * transaction, so nothing left for the owner is lost between the two.
 *
 * Each operation touches one primary-key row, so its cost does not grow with
 * the number of runs, unlike Graphile named queues, whose `get_job` locks
 * every queue row on each poll and which are never deleted.
 */

const LEASES_TABLE = '"workflow"."workflow_run_delivery_leases"';

/** A job left on a lease for its owner to re-add. */
export interface LeftJob {
  /** Graphile task identifier. */
  task: string;
  /** The job's payload (an encoded `MessageData`). */
  payload: unknown;
  jobKey?: string;
  maxAttempts?: number;
}

/** A handoff's continuation job (see {@link RunLeases.handoff}). */
export interface ContinuationJob {
  task: string;
  payload: unknown;
  jobKey?: string;
  jobKeyMode: 'preserve_run_at' | 'unsafe_dedupe';
  maxAttempts: number;
  priority?: number;
  runAt?: Date;
}

export type ClaimResult =
  /** This job owns the run's lease. */
  | { owner: true }
  /** Another job owns it; this job's message was left for that owner. */
  | { owner: false }
  /** The leases table is missing (migration 0031 not applied). */
  | { owner: undefined };

export interface RunLeases {
  /**
   * Take the run's lease for `jobId`, or leave `left` for its live owner.
   * `kind` says whether a later delivery covers the message (`'wake'`) or it
   * must be re-added (`'deferred'`).
   */
  claim(
    runId: string,
    jobId: string,
    left: LeftJob,
    kind: 'wake' | 'deferred',
    hasResume: boolean
  ): Promise<ClaimResult>;
  /**
   * The wake left on the owner's lease, cleared from the row, or `undefined`
   * when there is none (or `jobId` no longer owns the lease).
   */
  takeWake(runId: string, jobId: string): Promise<LeftJob | undefined>;
  /**
   * Add a handoff's continuation job and hand it the lease `jobId` owns, in
   * one transaction. The continuation is not visible to any worker before it
   * owns the lease: a worker that took it in between would find the lease
   * still held, leave its message on the row and complete, and the lease
   * would pass to a job that no longer exists, leaving the run nothing to
   * run. Returns whether the lease was handed over (`false` when `jobId` no
   * longer owns it; the continuation is added either way).
   */
  handoff(
    runId: string,
    jobId: string,
    continuation: ContinuationJob
  ): Promise<boolean>;
  /** Release the lease, re-adding as jobs what was left on it. */
  release(runId: string, jobId: string): Promise<void>;
  /**
   * Recover the leases whose owner can no longer run (its job is gone, or
   * used its last attempt and is not locked), of every deployment sharing
   * the database: delete each row and re-add what was left on it as jobs, in
   * one transaction. Their senders acknowledged their own jobs, so without
   * this a deferred message (a start, a hook's input) left for an owner that
   * died on its last attempt would be stranded until the run's next message
   * took the lease over. Returns how many leases were recovered (at most
   * `limit`) and how many jobs were re-added.
   */
  recoverOrphans(limit?: number): Promise<{ leases: number; jobs: number }>;
}

/** A Graphile job, by id, that can still run and so still owns its lease. */
const liveOwner = (graphileSchema: string, leases: string) => `EXISTS (
  SELECT 1 FROM ${graphileSchema}._private_jobs AS owner_job
  WHERE owner_job.id = ${leases}.owner_job_id
    AND (owner_job.locked_at IS NOT NULL
      OR owner_job.attempts < owner_job.max_attempts)
)`;

// Take the lease: insert the row, or take over a row this job already owns
// (its own redelivery) or whose owner can no longer run. Returns no row when
// a live owner holds it.
const claimSql = (graphileSchema: string) => `INSERT INTO ${LEASES_TABLE}
  AS leases (run_id, owner_job_id)
VALUES ($1, $2::bigint)
ON CONFLICT (run_id) DO UPDATE SET owner_job_id = excluded.owner_job_id,
  claimed_at = now()
WHERE leases.owner_job_id = excluded.owner_job_id
  OR NOT ${liveOwner(graphileSchema, 'leases')}
RETURNING 1`;

// Leave a message for the lease's live owner. Returns no row when the lease
// was released (or its owner can no longer run) since the claim was refused:
// the caller claims again.
const leaveSql = (graphileSchema: string) => `UPDATE ${LEASES_TABLE} AS leases
SET wake = CASE
      WHEN $3::text = 'wake'
        AND (leases.wake IS NULL OR (NOT leases.wake_resume AND $5::boolean))
      THEN $4::jsonb ELSE leases.wake END,
    wake_resume = leases.wake_resume OR ($3::text = 'wake' AND $5::boolean),
    deferred = CASE
      WHEN $3::text = 'deferred' THEN leases.deferred || jsonb_build_array($4::jsonb)
      ELSE leases.deferred END
WHERE leases.run_id = $1 AND leases.owner_job_id <> $2::bigint
  AND ${liveOwner(graphileSchema, 'leases')}
RETURNING 1`;

const takeWakeSql = `WITH old AS (
  SELECT run_id, wake FROM ${LEASES_TABLE}
  WHERE run_id = $1 AND owner_job_id = $2::bigint AND wake IS NOT NULL
  FOR UPDATE
)
UPDATE ${LEASES_TABLE} AS leases SET wake = NULL, wake_resume = false
FROM old WHERE leases.run_id = old.run_id
RETURNING old.wake`;

const transferSql = `UPDATE ${LEASES_TABLE}
SET owner_job_id = $3::bigint, claimed_at = now()
WHERE run_id = $1 AND owner_job_id = $2::bigint
RETURNING 1`;

// The common release: nothing was left on the lease, so one statement does.
const releaseEmptySql = `DELETE FROM ${LEASES_TABLE}
WHERE run_id = $1 AND owner_job_id = $2::bigint
  AND wake IS NULL AND deferred = '[]'::jsonb
RETURNING 1`;

// Recovering orphaned leases takes two statements in one transaction. The
// first locks the candidates: leases whose owner looked unable to run. The
// second rechecks each owner with its own, later snapshot and deletes only
// those still orphaned, re-adding what was left on them as jobs. One
// statement is not enough: when its row lock follows a take-over committed
// after the statement began, Postgres rechecks the row against that take-over,
// but the owner's job is read with the statement's earlier snapshot, so a new
// owner's job is not seen and a live lease would be deleted. With the
// candidates locked, no take-over can commit between the two statements.
const lockOrphansSql = (graphileSchema: string) => `SELECT run_id
FROM ${LEASES_TABLE} AS leases
WHERE NOT ${liveOwner(graphileSchema, 'leases')}
LIMIT $1
FOR UPDATE`;

const recoverOrphansSql = (graphileSchema: string) => `WITH removed AS (
  DELETE FROM ${LEASES_TABLE} AS leases
  WHERE leases.run_id = ANY($1::varchar[])
    AND NOT ${liveOwner(graphileSchema, 'leases')}
  RETURNING leases.wake, leases.deferred
), left_jobs AS (
  SELECT job FROM removed,
    jsonb_array_elements(removed.deferred || CASE
      WHEN removed.wake IS NULL THEN '[]'::jsonb
      ELSE jsonb_build_array(removed.wake) END) AS job
), added AS (
  SELECT ${graphileSchema}.add_job(
    identifier => left_jobs.job->>'task',
    payload => (left_jobs.job->'payload')::json,
    job_key => left_jobs.job->>'jobKey',
    job_key_mode => 'preserve_run_at',
    max_attempts => (left_jobs.job->>'maxAttempts')::int
  ) FROM left_jobs
)
SELECT (SELECT count(*)::int FROM removed) AS leases,
  (SELECT count(*)::int FROM added) AS jobs`;

const releaseSql = `DELETE FROM ${LEASES_TABLE}
WHERE run_id = $1 AND owner_job_id = $2::bigint
RETURNING wake, deferred`;

const addContinuationSql = (graphileSchema: string) =>
  `SELECT (${graphileSchema}.add_job(identifier => $1, payload => $2::json,
    run_at => $3::timestamptz, max_attempts => $4::int, job_key => $5,
    priority => $6::int, job_key_mode => $7)).id::text AS id`;

const addJobSql = (graphileSchema: string) =>
  `SELECT ${graphileSchema}.add_job(identifier => $1, payload => $2::json,
    job_key => $3, job_key_mode => 'preserve_run_at', max_attempts => $4)`;

/** Postgres `undefined_table`: migration 0031 has not run. */
export const isMissingTable = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '42P01';

/** Attempts at claiming before giving up on a lease that keeps changing hands. */
const MAX_CLAIM_TRIES = 5;

export function createRunLeases(pool: Pool): RunLeases {
  const graphileSchema = escapeIdentifier(
    process.env.GRAPHILE_WORKER_SCHEMA || 'graphile_worker'
  );
  const claimQuery = claimSql(graphileSchema);
  const leaveQuery = leaveSql(graphileSchema);
  const addJobQuery = addJobSql(graphileSchema);
  const addContinuationQuery = addContinuationSql(graphileSchema);
  const lockOrphansQuery = lockOrphansSql(graphileSchema);
  const recoverOrphansQuery = recoverOrphansSql(graphileSchema);
  let warnedMissing = false;

  function missing(): ClaimResult {
    if (!warnedMissing && process.env.WORKFLOW_JSON_MODE !== '1') {
      warnedMissing = true;
      console.warn(
        "[world-postgres] workflow.workflow_run_delivery_leases does not exist; run `bootstrap` (`npx --package=@workflow/world-postgres bootstrap`, migration 0031). Until then a spec 9 run's deliveries are not serialized across workers; the in-band fence still refuses an overlapping delivery's writes."
      );
    }
    return { owner: undefined };
  }

  return {
    async claim(runId, jobId, left, kind, hasResume) {
      try {
        for (let tries = 0; tries < MAX_CLAIM_TRIES; tries++) {
          const claimed = await pool.query(claimQuery, [runId, jobId]);
          if (claimed.rowCount) return { owner: true };
          const leftRows = await pool.query(leaveQuery, [
            runId,
            jobId,
            kind,
            JSON.stringify(left),
            hasResume,
          ]);
          if (leftRows.rowCount) return { owner: false };
        }
      } catch (error) {
        if (isMissingTable(error)) return missing();
        throw error;
      }
      // The lease changed hands on every try: run unserialized, as before
      // the lease existed. The in-band fence keeps an overlap safe.
      return { owner: undefined };
    },
    async takeWake(runId, jobId) {
      const { rows } = await pool.query<{ wake: LeftJob }>(takeWakeSql, [
        runId,
        jobId,
      ]);
      return rows[0]?.wake;
    },
    async handoff(runId, jobId, continuation) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ id: string }>(
          addContinuationQuery,
          [
            continuation.task,
            JSON.stringify(continuation.payload),
            continuation.runAt ?? null,
            continuation.maxAttempts,
            continuation.jobKey ?? null,
            continuation.priority ?? null,
            continuation.jobKeyMode,
          ]
        );
        const moved = await client.query(transferSql, [
          runId,
          jobId,
          rows[0]!.id,
        ]);
        await client.query('COMMIT');
        return Boolean(moved.rowCount);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async recoverOrphans(limit = 1000) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{ run_id: string }>(
          lockOrphansQuery,
          [limit]
        );
        if (locked.rows.length === 0) {
          await client.query('COMMIT');
          return { leases: 0, jobs: 0 };
        }
        const { rows } = await client.query<{ leases: number; jobs: number }>(
          recoverOrphansQuery,
          [locked.rows.map((row) => row.run_id)]
        );
        await client.query('COMMIT');
        return rows[0] ?? { leases: 0, jobs: 0 };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async release(runId, jobId) {
      const empty = await pool.query(releaseEmptySql, [runId, jobId]);
      if (empty.rowCount) return;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{
          wake: LeftJob | null;
          deferred: LeftJob[];
        }>(releaseSql, [runId, jobId]);
        const row = rows[0];
        const left = row
          ? [...row.deferred, ...(row.wake ? [row.wake] : [])]
          : [];
        for (const job of left) {
          await client.query(addJobQuery, [
            job.task,
            JSON.stringify(job.payload),
            job.jobKey ?? null,
            job.maxAttempts ?? null,
          ]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** Quote an SQL identifier, as `pg`'s `escapeIdentifier` does. */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
