export interface CloudflareWorldConfig {
  /** D1 database binding for the global index */
  db: D1Database;
  /** Durable Object namespace binding for WorkflowRunDO */
  runs: DurableObjectNamespace;
  /** Cloudflare Queue binding for message dispatch */
  queue: globalThis.Queue;
  /** Optional: port for local executor (same pattern as world-postgres) */
  port?: number;
}
