import type { Pool } from 'pg';

type PgConnectionConfig =
  | { connectionString: string; maxPoolSize?: number; pool?: undefined }
  | { pool: Pool; connectionString?: undefined; maxPoolSize?: undefined };

export type PostgresWorldConfig = PgConnectionConfig & {
  /**
   * Prefix of the Graphile Worker tasks this World enqueues to and claims
   * from (`${jobPrefix}flows`). Apps sharing a database keep their jobs apart
   * by using distinct prefixes. Each run is stamped with the prefix of the
   * World that created it, and `start()` re-enqueues only the active runs
   * stamped with this World's prefix (plus unstamped runs, created before
   * the stamp existed). Defaults to `workflow_`.
   */
  jobPrefix?: string;
  /**
   * Pins every run to the deployment (for example, the container image
   * version) that started it, the way Vercel deployments do.
   *
   * Set, it becomes part of this World's effective job prefix
   * (`${jobPrefix}${deploymentId}_`), so each deployment's workers claim only
   * the jobs of runs that deployment started, and startup recovery re-enqueues
   * only those runs. A message enqueued for another deployment (a hook
   * resumed from a newer deployment, say) is routed to that deployment's
   * task, and the World declares `deploymentAffinity`. Keep a deployment's
   * workers running until its runs have finished: nothing else claims them.
   *
   * Letters, digits, `.`, `-`, `_` and `@`; at most 100 characters. Defaults
   * to WORKFLOW_POSTGRES_DEPLOYMENT_ID. Unset, every process sharing the
   * `jobPrefix` claims every run, and `getDeploymentId()` reports `postgres`.
   */
  deploymentId?: string;
  /**
   * namespace for queue topic prefixes (e.g. 'custom' → '__custom_wkf_workflow_').
   * defaults to WORKFLOW_QUEUE_NAMESPACE env var if not provided.
   */
  namespace?: string;
  queueConcurrency?: number;
  /** Milliseconds between idle job fetches per worker. Defaults to 500. */
  pollInterval?: number;
  /** Enable experimental invoke() delivery with one Graphile execution queue per run. */
  enableInvoke?: boolean;
  /**
   * Seconds a running delivery's Graphile job lock may go unrenewed before
   * another process releases any of this World's jobs for redelivery. Use the
   * same value on every process that shares the database, keep it well above
   * the longest time a process can go without running its timers (a blocked
   * event loop) or getting a pool connection, and set it only once every
   * process runs a version that renews its locks. 30 is a good value when
   * more than one process shares the database.
   *
   * Defaults to WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS. When neither is
   * set, every delivery still renews its lock and registers its worker as
   * renewing (`workflow.workflow_job_lock_holders`, migration 0030), and only
   * the jobs of a spec 9 run's named queue whose holder registered are
   * released, after 300 seconds unrenewed; other jobs keep Graphile Worker's
   * fixed 4 hour reset. `0` turns renewal and the release of stale locks off,
   * which leaves recovery to that reset and to restarts.
   */
  jobLockStaleSeconds?: number;
  /**
   * Whether the application coordinates shutdown instead of Graphile Worker
   * responding automatically. The application must await world.close().
   * Defaults to false. The package's default createWorld() configuration
   * enables it when WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN is `1`.
   */
  applicationManagedShutdown?: boolean;
  /**
   * Override the flush interval (in ms) for buffered stream writes.
   * Default is 10ms. Set to 0 for immediate flushing.
   */
  streamFlushIntervalMs?: number;
};

const DEFAULT_JOB_PREFIX = 'workflow_';

/**
 * The effective `jobPrefix`: the one the queue builds its Graphile task names
 * from, and the one stamped on the runs this World creates. Both must come
 * from here, so that recovery only ever re-enqueues a run into the task whose
 * runner claims it.
 *
 * Pass `deploymentId` to resolve the prefix of another deployment sharing this
 * World's `jobPrefix`, the task a message for one of its runs goes to.
 */
export function resolveJobPrefix(
  config: Pick<PostgresWorldConfig, 'jobPrefix' | 'deploymentId'>,
  deploymentId: string | undefined = config.deploymentId
): string {
  const base = config.jobPrefix || DEFAULT_JOB_PREFIX;
  if (deploymentId === undefined) {
    return base;
  }
  assertValidDeploymentId(deploymentId);
  return `${base}${deploymentId}_`;
}

const DEPLOYMENT_ID = /^[A-Za-z0-9._@-]{1,100}$/;

export function assertValidDeploymentId(deploymentId: string): void {
  if (!DEPLOYMENT_ID.test(deploymentId)) {
    throw new Error(
      `Invalid Postgres World deploymentId ${JSON.stringify(deploymentId)}: use 1-100 letters, digits, ".", "-", "_" or "@"`
    );
  }
}
