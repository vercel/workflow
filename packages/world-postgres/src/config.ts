import type { Pool } from 'pg';

type PgConnectionConfig =
  | { connectionString: string; maxPoolSize?: number; pool?: undefined }
  | { pool: Pool; connectionString?: undefined; maxPoolSize?: undefined };

export type PostgresWorldConfig = PgConnectionConfig & {
  jobPrefix?: string;
  queueConcurrency?: number;
  /**
   * Override the flush interval (in ms) for buffered stream writes.
   * Default is 10ms. Set to 0 for immediate flushing.
   */
  streamFlushIntervalMs?: number;
  /**
   * Disable prepared statements in the embedded graphile-worker. Required when
   * the connection pool routes traffic through a layer that cannot honour
   * per-session prepared statements, such as PgBouncer in transaction pooling
   * mode or PGlite-socket (PGlite multiplexes many TCP clients onto a single
   * WASM session). When `true`, graphile-worker's `noPreparedStatements` flag
   * is forwarded to its internal `run()` and `makeWorkerUtils()` calls.
   */
  noPreparedStatements?: boolean;
};
