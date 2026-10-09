import type { Pool } from 'pg';

type PgConnectionConfig =
  | { connectionString: string; maxPoolSize?: number; pool?: undefined }
  | { pool: Pool; connectionString?: undefined; maxPoolSize?: undefined };

/** A worker the queue's Graphile Worker runner lost. See `onWorkerLost`. */
export type LostWorker = {
  /** Why releasing the job failed. */
  error: unknown;
  workerId: string;
  /**
   * The job whose release failed. Unless the release committed before it
   * failed, the job, and its named queue if it has one, stay locked until
   * Graphile Worker resets locks older than 4 hours.
   */
  jobId: string | undefined;
};

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
   * Whether the application coordinates shutdown instead of Graphile Worker
   * responding automatically. The application must await world.close().
   * Defaults to false. The package's default createWorld() configuration
   * enables it when WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN is `1`.
   */
  applicationManagedShutdown?: boolean;
  /**
   * Called for each worker Graphile Worker ends because releasing its job
   * (completing or failing it) failed with an error Graphile Worker does not
   * retry, such as a dropped connection, or with one that outlasted its 100
   * retries. Graphile Worker reports that only to its own logger. Whether or
   * not this is set, the queue starts a runner in place of one that lost a
   * worker unless that runner is stopping, and it logs an error this throws or
   * rejects with. Defaults to a console warning.
   */
  onWorkerLost?: (lost: LostWorker) => void | Promise<void>;
  /**
   * Override the flush interval (in ms) for buffered stream writes.
   * Default is 10ms. Set to 0 for immediate flushing.
   */
  streamFlushIntervalMs?: number;
};
