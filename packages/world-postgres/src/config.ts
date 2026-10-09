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
 */
export function resolveJobPrefix(
  config: Pick<PostgresWorldConfig, 'jobPrefix'>
): string {
  return config.jobPrefix || DEFAULT_JOB_PREFIX;
}
