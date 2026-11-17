import type { Pool } from 'pg';
import {
  assertValidDeploymentId,
  type PostgresWorldConfig,
  resolveJobPrefix,
} from '../config.js';

/** The work a pinned deployment has left (see `deploymentId`). */
export interface DeploymentBacklog {
  readonly deploymentId: string;
  /** Runs this deployment started that have not finished. Zero: safe to delete its workers. */
  readonly activeRuns: number;
  /** Jobs due now, or running, on this deployment's tasks. */
  readonly dueDeliveries: number;
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

/** The schema Graphile Worker resolves when none is configured. */
function graphileSchema(): string {
  const schema = process.env.GRAPHILE_WORKER_SCHEMA || 'graphile_worker';
  return `"${schema.replace(/"/g, '""')}"`;
}

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
  const [runs, jobs] = await Promise.all([
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
  ]);
  const activeRuns = Number(runs.rows[0]?.count ?? 0);
  const dueDeliveries = Number(jobs.rows[0]?.count ?? 0);
  return {
    deploymentId,
    activeRuns,
    dueDeliveries,
    wanted: activeRuns > 0 ? dueDeliveries : 0,
  };
}

/**
 * Every pinned deployment sharing this `jobPrefix` that has unfinished runs,
 * and how many. A deployment listed here with no workers has runs nothing
 * will execute.
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
  const { rows } = await pool.query<{ job_prefix: string; count: string }>(
    `SELECT job_prefix, count(*) FROM workflow.workflow_runs
      WHERE starts_with(job_prefix, $1) AND length(job_prefix) > length($1) + 1
        AND status IN ('pending', 'running')
      GROUP BY job_prefix`,
    [base]
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
