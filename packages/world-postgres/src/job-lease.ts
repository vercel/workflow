import type { Pool } from 'pg';
import { operatorLog } from './logger.js';

/**
 * The stale window when neither `jobLockStaleSeconds` nor
 * `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS` is set: every delivery renews its
 * lock, and the release of stale locks covers only the per-run named queues
 * (a spec 9 run's orchestrator deliveries, invoke mode's executor lane) and
 * only jobs whose holder registered itself as renewing (see
 * {@link JobLeasePolicy}). Well above an inline step's longest synchronous
 * stretch, so a blocked event loop does not turn into a second owner of a
 * running inline step, and far below Graphile Worker's fixed 4 hours.
 */
export const DEFAULT_NAMED_QUEUE_LOCK_STALE_SECONDS = 300;
export const JOB_LOCK_STALE_SECONDS_ENV =
  'WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS';

/**
 * What this process renews and releases.
 *
 * - `'all'`: `jobLockStaleSeconds` (or the environment variable) set above
 *   `0`. Releases every job of this World's tasks whose lock went unrenewed
 *   for the window, whoever holds it. The operator asserts that every process
 *   sharing the database renews.
 * - `'named-queues'`: the default. Releases only jobs in this World's per-run
 *   named queues, and only those whose holder is a worker registered in
 *   `workflow.workflow_job_lock_holders`, which only a renewing process
 *   writes. A process on an earlier version (5.1.0 renews only when the
 *   window is set) never registers, so its long deliveries are never released
 *   under it and its unfenced acknowledgement cannot delete a redelivery's
 *   row. Its jobs keep Graphile Worker's 4 hour reset.
 * - `'off'`: `0` set explicitly. Neither renews nor releases.
 */
export type JobLeasePolicy =
  | { scope: 'off'; staleSeconds: 0 }
  | { scope: 'all' | 'named-queues'; staleSeconds: number };

/**
 * Resolve the explicitly configured stale window: the `jobLockStaleSeconds`
 * option, then `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS`. `undefined` when
 * neither is set (or the environment value is invalid), which selects the
 * default policy (see {@link resolveJobLeasePolicy}).
 */
export function resolveJobLockStaleSeconds(
  configured?: number
): number | undefined {
  if (configured !== undefined) {
    if (!isValidStaleSeconds(configured)) {
      throw new RangeError(
        `jobLockStaleSeconds must be 0 (disabled) or at least 1, got ${configured}`
      );
    }
    return configured;
  }
  const raw = process.env[JOB_LOCK_STALE_SECONDS_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!isValidStaleSeconds(parsed)) {
    warn(
      `[world-postgres] Ignoring ${JOB_LOCK_STALE_SECONDS_ENV}=${JSON.stringify(raw)}: expected 0 (disabled) or a number of seconds of at least 1. Using the default: renew every delivery and release only per-run named-queue jobs of renewing holders after ${DEFAULT_NAMED_QUEUE_LOCK_STALE_SECONDS}s.`
    );
    return undefined;
  }
  return parsed;
}

/**
 * The lease policy: an explicit window above `0` releases every job of this
 * World (`'all'`), an explicit `0` turns renewal and release off, and no
 * setting renews every delivery and releases only per-run named-queue jobs of
 * registered (renewing) holders after
 * {@link DEFAULT_NAMED_QUEUE_LOCK_STALE_SECONDS} (`'named-queues'`).
 */
export function resolveJobLeasePolicy(
  configured?: number,
  defaultStaleSeconds = DEFAULT_NAMED_QUEUE_LOCK_STALE_SECONDS
): JobLeasePolicy {
  const explicit = resolveJobLockStaleSeconds(configured);
  if (explicit === undefined) {
    return { scope: 'named-queues', staleSeconds: defaultStaleSeconds };
  }
  if (explicit === 0) return { scope: 'off', staleSeconds: 0 };
  return { scope: 'all', staleSeconds: explicit };
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
// it, and the lock of its named queue (a spec 9 run's or invoke mode's per-run queue).
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

/**
 * The workers of renewing processes: what tells the default sweep a holder
 * apart from one on an earlier version, which neither renews nor fences its
 * acknowledgement. Migration 0030.
 */
const HOLDERS_TABLE = '"workflow"."workflow_job_lock_holders"';

// Mark workers as renewing. `renewed_at` only ages the row out once its worker
// holds no job (see `cleanupSql`); it is not a liveness signal, which is the
// job's own `locked_at`.
const registerSql = `INSERT INTO ${HOLDERS_TABLE} AS holders (worker_id, renewed_at)
SELECT DISTINCT unnest($1::text[]), now()
ON CONFLICT (worker_id) DO UPDATE SET renewed_at = excluded.renewed_at`;

// The default sweep: the stale-lock reset above, restricted to jobs in this
// World's per-run named queues (`<prefix><runId><suffix>`) whose holder is
// registered as renewing. A job held by any other worker keeps its lock until
// Graphile Worker's own 4 hour reset.
const namedQueueSweepSql = (schema: string) => `WITH stale AS (
  SELECT jobs.id, jobs.job_queue_id, jobs.locked_by
  FROM ${schema}._private_jobs AS jobs
  JOIN ${schema}._private_tasks AS tasks ON tasks.id = jobs.task_id
  JOIN ${schema}._private_job_queues AS job_queues
    ON job_queues.id = jobs.job_queue_id
  WHERE jobs.locked_at < now() - make_interval(secs => $1::double precision)
    AND tasks.identifier = ANY($2::text[])
    AND length(job_queues.queue_name) > length($3::text) + length($4::text)
    AND left(job_queues.queue_name, length($3::text)) = $3::text
    AND right(job_queues.queue_name, length($4::text)) = $4::text
    AND EXISTS (
      SELECT 1 FROM ${HOLDERS_TABLE} AS holders
      WHERE holders.worker_id = jobs.locked_by
    )
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

// Forget workers that hold no job and have not registered for a day: workers
// of processes that exited. A live worker re-registers well within that (see
// `REREGISTER_MS`) before it next relies on its row.
const cleanupSql = (schema: string) => `DELETE FROM ${HOLDERS_TABLE} AS holders
WHERE holders.renewed_at < now() - interval '1 day'
  AND NOT EXISTS (
    SELECT 1 FROM ${schema}._private_jobs AS jobs
    WHERE jobs.locked_by = holders.worker_id
  )`;

/** How often a worker refreshes its registration; well below the cleanup's day. */
const REREGISTER_MS = 60 * 60 * 1000;
/** How long a failed registration keeps deliveries from trying again on start. */
const REGISTRATION_RETRY_MS = 60_000;
/** How often a sweeping process forgets the workers of exited processes. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Postgres `undefined_table`: migration 0030 has not run. */
const isMissingTable = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '42P01';

const MISSING_TABLE_HINT =
  "workflow.workflow_job_lock_holders does not exist; run `bootstrap` (`npx --package=@workflow/world-postgres bootstrap`, migration 0030). Until then, no process on the default policy (`jobLockStaleSeconds` unset) releases a per-run named-queue job of a process that dies; such a job is recovered by the next start() or after Graphile Worker's 4 hours";

/** An operator notice (see `operatorLog`). */
function warn(message: string, ...rest: unknown[]): void {
  operatorLog.warn(message, ...rest);
}

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
  /**
   * Start releasing this World's jobs whose locks went unrenewed. Idempotent.
   * Under the `'named-queues'` scope only jobs in a named queue
   * `<namedQueues.prefix><runId><namedQueues.suffix>` are released, and
   * without `namedQueues` nothing is.
   */
  startSweeper(
    taskIdentifiers: string[],
    namedQueues?: { prefix: string; suffix: string }
  ): void;
  /** Stop renewing and sweeping, and wait for queries in flight. */
  stop(): Promise<void>;
}

export interface JobLeaseOptions {
  staleSeconds: number;
  /**
   * What the sweep releases (see {@link JobLeasePolicy}). Defaults to
   * `'all'`. Renewal and holder registration are the same in both scopes.
   */
  scope?: 'all' | 'named-queues';
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
 *
 * Every renewing worker also registers itself in
 * `workflow.workflow_job_lock_holders` before its delivery runs (once an hour
 * per worker, and again on a renewal tick if that failed). Under the
 * `'named-queues'` scope, the sweep releases only jobs of registered workers,
 * so a process that does not renew (an earlier version) is never released
 * under. A missing table never fails a delivery: the job's own lock renewal
 * and the acknowledgement fence do not read it.
 */
export function createJobLeases(
  pool: Pool,
  {
    staleSeconds,
    scope = 'all',
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
  const sweepQuery =
    scope === 'all' ? sweepSql(schema) : namedQueueSweepSql(schema);
  const cleanupQuery = cleanupSql(schema);

  const held = new Set<HeldJob>();
  let stopped = false;
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let renewing: Promise<void> | undefined;
  let renewFailing = false;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let sweeping: Promise<void> | undefined;
  let sweepIdentifiers: string[] | undefined;
  let sweepNamedQueues: { prefix: string; suffix: string } | undefined;
  let lastCleanupAt = now();
  /** Monotonic ms of each worker's last successful registration. */
  const registeredAt = new Map<string, number>();
  let registrationRetryAt = Number.NEGATIVE_INFINITY;
  let registrationFailing = false;
  let sweepFailing = false;
  // Cleared when this process's own renewal or sweep fails. After an outage,
  // the first successful sweep only re-arms, so that holders get a renewal in
  // before peers release their jobs.
  let sweepArmed = true;

  function markLost(job: HeldJob) {
    if (job.lost) return;
    job.lost = true;
    warn(
      `[world-postgres] Lost the lock on Graphile job ${job.id}${job.taskIdentifier ? ` (${job.taskIdentifier})` : ''}: it is no longer locked by ${job.workerId}, usually because it went unrenewed for ${staleSeconds}s and another process released it for redelivery. This delivery will not be acknowledged.`
    );
  }

  /** Registrations started off the renewal path, awaited by `stop()`. */
  const registering = new Set<Promise<void>>();
  /** Workers one of those registrations is for, so a tick does not repeat it. */
  const registeringWorkers = new Set<string>();
  function registerInBackground(workerIds: string[]) {
    const pendingIds = workerIds.filter((id) => !registeringWorkers.has(id));
    if (pendingIds.length === 0) return;
    for (const id of pendingIds) registeringWorkers.add(id);
    const pending = register(pendingIds).finally(() => {
      for (const id of pendingIds) registeringWorkers.delete(id);
      registering.delete(pending);
    });
    registering.add(pending);
  }

  const needsRegistration = (workerId: string) => {
    const at = registeredAt.get(workerId);
    return at === undefined || now() - at > REREGISTER_MS;
  };

  /**
   * Mark these workers as renewing, so the default sweep may release their
   * jobs once they go unrenewed. Never throws: a worker left unregistered
   * only keeps Graphile Worker's 4 hour reset for its named-queue jobs.
   */
  async function register(workerIds: string[]) {
    if (workerIds.length === 0 || now() < registrationRetryAt) return;
    const sentAt = now();
    try {
      await pool.query(registerSql, [workerIds]);
      for (const workerId of workerIds) registeredAt.set(workerId, sentAt);
      if (registrationFailing) {
        registrationFailing = false;
        warn(
          '[world-postgres] Registering Graphile workers as renewing recovered'
        );
      }
    } catch (error) {
      registrationRetryAt = now() + REGISTRATION_RETRY_MS;
      if (!registrationFailing) {
        registrationFailing = true;
        warn(
          isMissingTable(error)
            ? `[world-postgres] Could not register Graphile workers as renewing: ${MISSING_TABLE_HINT}.`
            : '[world-postgres] Failed to register Graphile workers as renewing; retrying:',
          ...(isMissingTable(error) ? [] : [error])
        );
      }
    }
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
        warn('[world-postgres] Renewing Graphile job locks recovered');
      }
      // A worker whose registration failed on start gets another try here,
      // without holding up the next renewal: a stalled registration must not
      // let a live delivery's lock go stale.
      registerInBackground([
        ...new Set(
          jobs
            .filter(
              (job) =>
                held.has(job) && !job.lost && needsRegistration(job.workerId)
            )
            .map((job) => job.workerId)
        ),
      ]);
    } catch (error) {
      // Not a lost lock: keep the jobs and try again on the next tick.
      sweepArmed = false;
      if (!renewFailing) {
        renewFailing = true;
        warn(
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
      if (scope === 'named-queues' && !sweepNamedQueues) return;
      const { rows } = await pool.query<{ id: string }>(sweepQuery, [
        staleSeconds,
        sweepIdentifiers,
        ...(scope === 'named-queues' && sweepNamedQueues
          ? [sweepNamedQueues.prefix, sweepNamedQueues.suffix]
          : []),
      ]);
      sweepFailing = false;
      if (rows.length > 0) {
        warn(
          `[world-postgres] Released ${rows.length} Graphile job(s) whose locks went unrenewed for ${staleSeconds}s, for redelivery: ${rows.map((row) => row.id).join(', ')}`
        );
      }
      await cleanup();
    } catch (error) {
      sweepArmed = false;
      if (!sweepFailing) {
        sweepFailing = true;
        warn(
          isMissingTable(error)
            ? `[world-postgres] Could not release stale Graphile job locks: ${MISSING_TABLE_HINT}.`
            : '[world-postgres] Failed to release stale Graphile job locks; retrying:',
          ...(isMissingTable(error) ? [] : [error])
        );
      }
    }
  }

  /** Forget the workers of exited processes, at most once an hour. */
  async function cleanup() {
    if (now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = now();
    try {
      await pool.query(cleanupQuery);
    } catch {
      // Harmless: the rows of exited workers only wait for the next try.
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
        // Held, and renewed, from the claim on: a registration that stalls
        // must neither keep the lock from being renewed nor make it look
        // more recently shown to be ours than it is, or a delivery could
        // acknowledge, unfenced, a job that a successor holds by then.
        const job: HeldJob = { ...identity, lost: false, confirmedAt: now() };
        held.add(job);
        scheduleRenewal();
        try {
          // Before the delivery runs, so that a process killed mid-delivery
          // is known to have renewed. Once an hour per worker.
          if (needsRegistration(identity.workerId)) {
            await register([identity.workerId]);
          }
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
    startSweeper(taskIdentifiers, namedQueues) {
      if (!enabled || stopped) return;
      sweepIdentifiers = [...new Set(taskIdentifiers)];
      sweepNamedQueues = namedQueues;
      scheduleSweep();
    },
    async stop() {
      stopped = true;
      clearTimeout(renewTimer);
      clearTimeout(sweepTimer);
      renewTimer = undefined;
      sweepTimer = undefined;
      await Promise.all([renewing, sweeping, ...registering]);
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
