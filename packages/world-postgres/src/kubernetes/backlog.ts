import type { Pool } from 'pg';
import {
  assertValidDeploymentId,
  type PostgresWorldConfig,
  resolveJobPrefix,
} from '../config.js';
import { worldPurgeTask } from '../retention.js';
import { graphileSchemaIdentifier } from '../run-lease.js';

/** The work a pinned deployment has left (see `deploymentId`). */
export interface DeploymentBacklog {
  readonly deploymentId: string;
  /**
   * Runs this deployment started that have not finished, counting a finished
   * one whose purge backstop is still outstanding (see {@link pendingPurges}).
   * Zero: safe to delete its workers.
   */
  readonly activeRuns: number;
  /**
   * Jobs due now, or running, on this deployment's tasks, and the due purge
   * backstops of its runs.
   */
  readonly dueDeliveries: number;
  /**
   * Finished zero-retention runs of this deployment whose purge backstop has
   * not run yet (see `purgeTask` in retention.ts). The backstop's task is
   * shared by every deployment, but until it has run the deployment that
   * finished the run keeps its workers and is woken for it, so a cluster
   * whose other deployments are all gone or scaled to zero still runs it.
   */
  readonly pendingPurges: number;
  /**
   * The deliveries this deployment's workers should be sized for: its due
   * jobs while it has unfinished runs, and zero otherwise, so a due backstop
   * timer of an already finished run never wakes a drained deployment.
   * Sleeping runs and runs waiting on a hook count as unfinished but have
   * nothing due, so their deployment scales to zero until they wake.
   */
  readonly wanted: number;
}

type BacklogConfig = Pick<PostgresWorldConfig, 'jobPrefix'>;

const DEPLOYMENT_ID = /^[A-Za-z0-9._@-]+$/;

const graphileSchema = graphileSchemaIdentifier;

/**
 * The purge backstops still to run: the job prefix of each one's run (`$1`
 * is the purge task), and whether it is due. A run's id is in the job's
 * payload.
 */
const owedPurgesSql = (where: string) => `SELECT runs.job_prefix,
    jobs.run_at <= now() AS due
  FROM ${graphileSchema()}._private_jobs AS jobs
  JOIN ${graphileSchema()}._private_tasks AS tasks ON tasks.id = jobs.task_id
  JOIN workflow.workflow_runs AS runs ON runs.id = jobs.payload->>'runId'
 WHERE tasks.identifier = $1 AND ${where}`;

/**
 * How much work a pinned deployment of this World has left: for scaling its
 * workers (a KEDA trigger reads `wanted`) and for deleting them once
 * `activeRuns` is zero.
 *
 * Reads Graphile Worker's internal tables, as the queue does, which is why
 * this lives here: they change with the pinned graphile-worker version.
 */
export async function getDeploymentBacklog(
  pool: Pool,
  config: BacklogConfig,
  deploymentId: string
): Promise<DeploymentBacklog> {
  const prefix = resolveJobPrefix(
    { jobPrefix: config.jobPrefix },
    deploymentId
  );
  const [runs, jobs, purges] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT count(*) FROM workflow.workflow_runs
        WHERE job_prefix = $1 AND status IN ('pending', 'running')`,
      [prefix]
    ),
    pool.query<{ count: string }>(
      `SELECT count(*) FROM ${graphileSchema()}._private_jobs AS jobs
         JOIN ${graphileSchema()}._private_tasks AS tasks ON tasks.id = jobs.task_id
        WHERE tasks.identifier = ANY($1) AND jobs.run_at <= now()`,
      [[`${prefix}flows`, `${prefix}flows_executor`]]
    ),
    pool.query<{ pending: string; due: string }>(
      `SELECT count(*) AS pending, count(*) FILTER (WHERE due) AS due
         FROM (${owedPurgesSql('runs.job_prefix = $2')}) AS owed`,
      [worldPurgeTask(config), prefix]
    ),
  ]);
  const pendingPurges = Number(purges.rows[0]?.pending ?? 0);
  const activeRuns = Number(runs.rows[0]?.count ?? 0) + pendingPurges;
  const dueDeliveries =
    Number(jobs.rows[0]?.count ?? 0) + Number(purges.rows[0]?.due ?? 0);
  return {
    deploymentId,
    activeRuns,
    dueDeliveries,
    pendingPurges,
    wanted: activeRuns > 0 ? dueDeliveries : 0,
  };
}

/**
 * Every pinned deployment sharing this `jobPrefix` that has unfinished runs,
 * and how many, counting finished runs whose purge backstop is outstanding
 * (see `DeploymentBacklog.pendingPurges`). A deployment listed here with no
 * workers has runs nothing will execute.
 *
 * Runs started without a `deploymentId` (unpinned) are not listed. Give each
 * application a `jobPrefix` that is not a prefix of another's: a run is
 * attributed by the text that follows this one.
 */
export async function listActiveDeployments(
  pool: Pool,
  config: BacklogConfig
): Promise<Map<string, number>> {
  const base = resolveJobPrefix({ jobPrefix: config.jobPrefix });
  const pinned = (column: string) =>
    `starts_with(${column}, $2) AND length(${column}) > length($2) + 1`;
  const { rows } = await pool.query<{ job_prefix: string; count: string }>(
    `SELECT job_prefix, count(*) FROM (
        SELECT job_prefix FROM workflow.workflow_runs
         WHERE ${pinned('job_prefix')} AND status IN ('pending', 'running')
        UNION ALL
        SELECT job_prefix FROM (${owedPurgesSql(pinned('runs.job_prefix'))}) AS owed
      ) AS unfinished
      GROUP BY job_prefix`,
    [worldPurgeTask(config), base]
  );
  const deployments = new Map<string, number>();
  for (const row of rows) {
    if (!row.job_prefix.endsWith('_')) continue;
    const deploymentId = row.job_prefix.slice(base.length, -1);
    if (!DEPLOYMENT_ID.test(deploymentId)) continue;
    try {
      assertValidDeploymentId(deploymentId, base);
    } catch {
      continue;
    }
    deployments.set(deploymentId, Number(row.count));
  }
  return deployments;
}

/**
 * Unfinished runs of this `jobPrefix` started without a `deploymentId`
 * (unpinned): a run from before the application pinned its runs, or one
 * created by a tool that doesn't set `WORKFLOW_POSTGRES_DEPLOYMENT_ID`. Only
 * a process without a deployment ID claims them. Counts finished runs whose
 * purge backstop is outstanding, as {@link listActiveDeployments} does.
 */
export async function countUnpinnedRuns(
  pool: Pool,
  config: BacklogConfig
): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT (SELECT count(*) FROM workflow.workflow_runs
               WHERE job_prefix = $2 AND status IN ('pending', 'running'))
          + (SELECT count(*) FROM (${owedPurgesSql('runs.job_prefix = $2')}) AS owed)
         AS count`,
    [worldPurgeTask(config), resolveJobPrefix({ jobPrefix: config.jobPrefix })]
  );
  return Number(rows[0]?.count ?? 0);
}
