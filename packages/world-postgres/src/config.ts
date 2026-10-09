import type { Pool } from 'pg';

type PgConnectionConfig =
  | { connectionString: string; maxPoolSize?: number; pool?: undefined }
  | { pool: Pool; connectionString?: undefined; maxPoolSize?: undefined };

export type PostgresWorldConfig = PgConnectionConfig & {
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
   * Seconds a running delivery's Graphile job lock may go unrenewed before
   * another process releases the job for redelivery. A delivery renews its
   * lock while it runs, so this bounds how long a job whose process died stays
   * locked. Use the same value on every process that shares the database, and
   * keep it well above the longest time a process can go without running its
   * timers (a blocked event loop) or getting a pool connection. `0` turns
   * renewal and the release of stale locks off, which leaves recovery to
   * Graphile Worker's fixed 4 hour reset and to restarts.
   * Defaults to WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS, then `0` (off).
   * 30 is a good value when more than one process shares the database; turn
   * it on once every process runs a version that renews its locks.
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
