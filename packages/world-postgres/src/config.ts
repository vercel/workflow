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
