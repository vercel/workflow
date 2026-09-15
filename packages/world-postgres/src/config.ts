import type { Pool } from 'pg';
import { z } from 'zod/v4';

type PgConnectionConfig =
  | { connectionString: string; maxPoolSize?: number; pool?: undefined }
  | { pool: Pool; connectionString?: undefined; maxPoolSize?: undefined };

export const PostgresWorldRoleSchema = z.enum(['producer', 'worker']);

export type PostgresWorldRole = z.infer<typeof PostgresWorldRoleSchema>;

export type PostgresWorldConfig = PgConnectionConfig & {
  jobPrefix?: string;
  /**
   * namespace for queue topic prefixes (e.g. 'custom' → '__custom_wkf_workflow_').
   * defaults to WORKFLOW_QUEUE_NAMESPACE env var if not provided.
   */
  namespace?: string;
  queueConcurrency?: number;
  /**
   * Whether this process both enqueues and executes messages (`worker`, the
   * default) or only enqueues them (`producer`). A producer's start() still
   * ensures the schema, so it can enqueue into a fresh database, but it never
   * starts a Graphile Worker runner and never re-enqueues active runs. Use it
   * for a deployment unit that submits work it cannot execute — one that did
   * not compile the workflow and step code, and so does not serve
   * `.well-known/workflow/v1/*` — so it neither claims jobs it can only fail
   * nor replays runs another process owns. The `WORKFLOW_POSTGRES_ROLE`
   * environment variable is used as a fallback when this option is unset.
   */
  role?: PostgresWorldRole;
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
