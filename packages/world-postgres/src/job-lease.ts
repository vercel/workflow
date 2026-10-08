import type { Pool } from 'pg';

/**
 * Seconds a claimed Graphile job's lock may go unrenewed before another
 * process releases it for redelivery. Matches the visibility window a queue
 * message has on Vercel Queues.
 */
export const DEFAULT_JOB_LOCK_STALE_SECONDS = 300;
export const JOB_LOCK_STALE_SECONDS_ENV =
  'WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS';

/**
 * Resolve the stale window: the `jobLockStaleSeconds` option, then
 * `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS`, then the default. `0` turns
 * renewal and the stale-lock sweep off, which leaves recovery to Graphile
 * Worker's fixed 4 hour reset and to `reenqueueActiveRuns` on start.
 */
export function resolveJobLockStaleSeconds(configured?: number): number {
  if (configured !== undefined) {
    if (!isValidStaleSeconds(configured)) {
      throw new RangeError(
        `jobLockStaleSeconds must be 0 (disabled) or at least 1, got ${configured}`
      );
    }
    return configured;
  }
  const raw = process.env[JOB_LOCK_STALE_SECONDS_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_JOB_LOCK_STALE_SECONDS;
  }
  const parsed = Number(raw);
  if (!isValidStaleSeconds(parsed)) {
    console.warn(
      `[world-postgres] Ignoring ${JOB_LOCK_STALE_SECONDS_ENV}=${JSON.stringify(raw)}: expected 0 (disabled) or a number of seconds of at least 1. Using ${DEFAULT_JOB_LOCK_STALE_SECONDS}.`
    );
    return DEFAULT_JOB_LOCK_STALE_SECONDS;
  }
  return parsed;
}

function isValidStaleSeconds(value: number): boolean {
  return Number.isFinite(value) && (value === 0 || value >= 1);
}

/**
 * Thrown in place of a delivery's result when this process can no longer show
 * that it holds the delivery's job lock. Graphile Worker completes a job with a
 * delete that is not fenced on the lock holder, so acknowledging here could
 * delete the row of a successor that has already claimed the job. Failing is
 * fenced on the holder, so it changes nothing; the job is (or has been)
 * redelivered instead, which the at-least-once contract already allows.
 */
export class JobLockLostError extends Error {
  readonly jobId: string;
  readonly workerId: string;

  constructor(jobId: string, workerId: string) {
    super(
      `[world-postgres] Graphile job ${jobId} is no longer locked by ${workerId}, so this delivery is not acknowledged; the job was released for redelivery`
    );
    this.name = 'JobLockLostError';
    this.jobId = jobId;
    this.workerId = workerId;
  }
}

// Refresh the lock of every job that is still held by the worker that claimed
// it, and the lock of its named queue (invoke mode's per-run executor queue).
// A `(job, worker)` pair missing from the result no longer holds the lock. The
// pair matters: after a release, another worker of this process can hold the
// same job id while the stale holder is still running.
const renewSql = (schema: string) => `WITH held AS (
  SELECT * FROM unnest($1::bigint[], $2::text[]) AS held(id, worker)
), renewed AS (
  UPDATE ${schema}._private_jobs AS jobs
  SET locked_at = now()
  FROM held
  WHERE jobs.id = held.id AND jobs.locked_by = held.worker
  RETURNING jobs.id, jobs.job_queue_id, jobs.locked_by
), renewed_queues AS (
  UPDATE ${schema}._private_job_queues AS job_queues
  SET locked_at = now()
  FROM renewed
  WHERE job_queues.id = renewed.job_queue_id
    AND job_queues.locked_by = renewed.locked_by
)
SELECT id::text AS id, locked_by AS worker FROM renewed`;

// Graphile Worker's own stale-lock reset (`resetLockedAt`), with a configurable
// window and scoped to this World's task identifiers so that other
// applications sharing the graphile_worker schema keep their locks. `SKIP
// LOCKED` plus READ COMMITTED's re-check of the row lets a renewal and a
// sweep race on one row safely in either order.
const sweepSql = (schema: string) => `WITH stale AS (
  SELECT jobs.id, jobs.job_queue_id, jobs.locked_by
  FROM ${schema}._private_jobs AS jobs
  JOIN ${schema}._private_tasks AS tasks ON tasks.id = jobs.task_id
  WHERE jobs.locked_at < now() - make_interval(secs => $1::double precision)
    AND tasks.identifier = ANY($2::text[])
  FOR UPDATE OF jobs SKIP LOCKED
), released AS (
  UPDATE ${schema}._private_jobs AS jobs
  SET locked_at = NULL, locked_by = NULL, run_at = greatest(jobs.run_at, now())
  FROM stale
  WHERE jobs.id = stale.id
  RETURNING jobs.id
), released_queues AS (
  UPDATE ${schema}._private_job_queues AS job_queues
  SET locked_at = NULL, locked_by = NULL
  FROM stale
  WHERE job_queues.id = stale.job_queue_id
    AND job_queues.locked_by = stale.locked_by
)
SELECT id::text AS id FROM released`;

type GraphileTask = (payload: unknown, helpers: unknown) => Promise<void>;
type RenewedRow = { id: string; worker: string };

// Node runs a timer whose delay does not fit in a signed 32-bit integer after
// 1 ms, which would turn a very long stale window into a busy loop.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
// Job ids are digits, so the separator cannot be ambiguous.
const holder = (id: string, workerId: string) => `${id}:${workerId}`;

interface HeldJob {
  id: string;
  workerId: string;
  taskIdentifier: string | undefined;
  lost: boolean;
  /** Monotonic ms at which a renewal that found the job still ours was sent. */
  confirmedAt: number;
}

export interface JobLeases {
  /** Whether renewal and the stale-lock sweep are on. */
  readonly enabled: boolean;
  /** Renew a task's job lock while it runs, and refuse to acknowledge a delivery whose lock was lost. */
  wrap(task: GraphileTask): GraphileTask;
  /** Start releasing this World's jobs whose locks went unrenewed. Idempotent. */
  startSweeper(taskIdentifiers: string[]): void;
  /** Stop renewing and sweeping, and wait for queries in flight. */
  stop(): Promise<void>;
}

export interface JobLeaseOptions {
  staleSeconds: number;
  /** Monotonic clock in milliseconds; injectable for tests. */
  now?: () => number;
  random?: () => number;
}

/**
 * Renew the Graphile Worker job locks of running deliveries, and release this
 * World's jobs whose locks go unrenewed for the stale window.
 *
 * graphile-worker 0.16 sets `locked_at` once, when a worker claims a job, and
 * only resets locks older than a fixed 4 hours. A worker that dies mid-delivery
 * therefore keeps its job locked for 4 hours, and on a deployment with several
 * hosts nothing redelivers it until a process restarts and re-enqueues active
 * runs. A healthy delivery that runs longer than 4 hours is reset while it
 * runs and delivered twice.
 */
export function createJobLeases(
  pool: Pool,
  {
    staleSeconds,
    now = () => performance.now(),
    random = Math.random,
  }: JobLeaseOptions
): JobLeases {
  const enabled = staleSeconds > 0;
  const staleMs = staleSeconds * 1000;
  const renewIntervalMs = Math.min(10_000, Math.max(250, staleMs / 4));
  const sweepIntervalMs = Math.max(500, staleMs / 2);
  // A delivery whose lock was last shown to be ours within this window cannot
  // have been swept yet, and has at least this long before it could be.
  const confirmWindowMs = staleMs / 2;

  // The schema Graphile Worker itself resolves when no `schema` option is
  // passed, which this World never passes.
  const schema = escapeIdentifier(
    process.env.GRAPHILE_WORKER_SCHEMA || 'graphile_worker'
  );
  const renewQuery = renewSql(schema);
  const sweepQuery = sweepSql(schema);

  const held = new Set<HeldJob>();
  let stopped = false;
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let renewing: Promise<void> | undefined;
  let renewFailing = false;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let sweeping: Promise<void> | undefined;
  let sweepIdentifiers: string[] | undefined;
  let sweepFailing = false;
  // Cleared when this process's own renewal or sweep fails. After an outage,
  // the first successful sweep only re-arms, so that holders get a renewal in
  // before peers release their jobs.
  let sweepArmed = true;

  function markLost(job: HeldJob) {
    if (job.lost) return;
    job.lost = true;
    console.warn(
      `[world-postgres] Lost the lock on Graphile job ${job.id}${job.taskIdentifier ? ` (${job.taskIdentifier})` : ''}: it is no longer locked by ${job.workerId}, usually because it went unrenewed for ${staleSeconds}s and another process released it for redelivery. This delivery will not be acknowledged.`
    );
  }

  function scheduleRenewal() {
    if (stopped || renewTimer || renewing || held.size === 0) return;
    renewTimer = setTimeout(() => {
      renewTimer = undefined;
      renewing = renewHeldJobs().finally(() => {
        renewing = undefined;
        scheduleRenewal();
      });
    }, renewIntervalMs);
    renewTimer.unref?.();
  }

  async function renewHeldJobs() {
    const jobs = [...held].filter((job) => !job.lost);
    if (jobs.length === 0) return;
    const sentAt = now();
    try {
      const { rows } = await pool.query<RenewedRow>(renewQuery, [
        jobs.map((job) => job.id),
        jobs.map((job) => job.workerId),
      ]);
      const renewed = new Set(rows.map((row) => holder(row.id, row.worker)));
      for (const job of jobs) {
        // A job released since the query was sent was acknowledged by Graphile
        // Worker (which deletes it); it was not lost.
        if (!held.has(job)) continue;
        if (renewed.has(holder(job.id, job.workerId))) job.confirmedAt = sentAt;
        else markLost(job);
      }
      if (renewFailing) {
        renewFailing = false;
        console.warn('[world-postgres] Renewing Graphile job locks recovered');
      }
    } catch (error) {
      // Not a lost lock: keep the jobs and try again on the next tick.
      sweepArmed = false;
      if (!renewFailing) {
        renewFailing = true;
        console.warn(
          '[world-postgres] Failed to renew Graphile job locks; retrying:',
          error
        );
      }
    }
  }

  async function confirm(job: HeldJob) {
    if (job.lost) throw new JobLockLostError(job.id, job.workerId);
    if (stopped || now() - job.confirmedAt <= confirmWindowMs) return;
    // Renewals have not shown the lock to be ours recently (a slow pool or a
    // database outage), so show it now: a successful renewal also keeps the
    // job from being swept before Graphile Worker acknowledges it.
    const { rows } = await pool.query<RenewedRow>(renewQuery, [
      [job.id],
      [job.workerId],
    ]);
    if (!rows.some((row) => row.id === job.id && row.worker === job.workerId)) {
      markLost(job);
      throw new JobLockLostError(job.id, job.workerId);
    }
  }

  function scheduleSweep() {
    if (stopped || sweepTimer || !sweepIdentifiers) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      sweepIntervalMs * (0.8 + 0.4 * random())
    );
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      sweeping = sweep().finally(() => {
        sweeping = undefined;
        scheduleSweep();
      });
    }, delay);
    sweepTimer.unref?.();
  }

  async function sweep() {
    try {
      if (!sweepArmed) {
        await pool.query('SELECT 1');
        sweepArmed = true;
        return;
      }
      const { rows } = await pool.query<{ id: string }>(sweepQuery, [
        staleSeconds,
        sweepIdentifiers,
      ]);
      sweepFailing = false;
      if (rows.length > 0) {
        console.warn(
          `[world-postgres] Released ${rows.length} Graphile job(s) whose locks went unrenewed for ${staleSeconds}s, for redelivery: ${rows.map((row) => row.id).join(', ')}`
        );
      }
    } catch (error) {
      sweepArmed = false;
      if (!sweepFailing) {
        sweepFailing = true;
        console.warn(
          '[world-postgres] Failed to release stale Graphile job locks; retrying:',
          error
        );
      }
    }
  }

  return {
    enabled,
    wrap(task) {
      if (!enabled) return task;
      return async (payload, helpers) => {
        const identity = jobIdentity(helpers);
        if (!identity || stopped) {
          await task(payload, helpers);
          return;
        }
        const job: HeldJob = { ...identity, lost: false, confirmedAt: now() };
        held.add(job);
        scheduleRenewal();
        try {
          await task(payload, helpers);
          await confirm(job);
        } finally {
          held.delete(job);
          if (held.size === 0 && renewTimer) {
            clearTimeout(renewTimer);
            renewTimer = undefined;
          }
        }
      };
    },
    startSweeper(taskIdentifiers) {
      if (!enabled || stopped) return;
      sweepIdentifiers = [...new Set(taskIdentifiers)];
      scheduleSweep();
    },
    async stop() {
      stopped = true;
      clearTimeout(renewTimer);
      clearTimeout(sweepTimer);
      renewTimer = undefined;
      sweepTimer = undefined;
      await Promise.all([renewing, sweeping]);
    },
  };
}

/** Quote an SQL identifier, as `pg`'s `escapeIdentifier` does. */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function jobIdentity(
  helpers: unknown
): Pick<HeldJob, 'id' | 'workerId' | 'taskIdentifier'> | undefined {
  const job =
    typeof helpers === 'object' && helpers !== null && 'job' in helpers
      ? (helpers.job as Record<string, unknown> | null | undefined)
      : undefined;
  if (
    typeof job?.id !== 'string' ||
    !/^\d+$/.test(job.id) ||
    typeof job.locked_by !== 'string' ||
    job.locked_by === ''
  ) {
    return undefined;
  }
  return {
    id: job.id,
    workerId: job.locked_by,
    taskIdentifier:
      typeof job.task_identifier === 'string' ? job.task_identifier : undefined,
  };
}
