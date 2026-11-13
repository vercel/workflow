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
  /** Hand the lease from `jobId` to `nextJobId` (a handoff's continuation). */
  transfer(runId: string, jobId: string, nextJobId: string): Promise<boolean>;
  /** Release the lease, re-adding as jobs what was left on it. */
  release(runId: string, jobId: string): Promise<void>;
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

const releaseSql = `DELETE FROM ${LEASES_TABLE}
WHERE run_id = $1 AND owner_job_id = $2::bigint
RETURNING wake, deferred`;

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
    async transfer(runId, jobId, nextJobId) {
      const { rowCount } = await pool.query(transferSql, [
        runId,
        jobId,
        nextJobId,
      ]);
      return Boolean(rowCount);
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
