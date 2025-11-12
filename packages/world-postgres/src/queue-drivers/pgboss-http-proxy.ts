import { createPgBossQueue } from './pgboss-base.js';
import type { QueueDriver } from './types.js';
import { createHttpProxy } from './wkf-http-proxy.js';

export interface PgBossHttpProxyConfig {
  connectionString: string;
  securityToken: string;
  jobPrefix?: string;
  queueConcurrency?: number;
  baseUrl?: string;
  port?: number;
}

/**
 * QueueDriver implementation using pg-boss for job management and HTTP for execution.
 * Workers make HTTP calls to the Next.js app's .well-known/workflow/v1/* endpoints.
 */
export function createPgBossHttpProxy(
  config: PgBossHttpProxyConfig
): QueueDriver {
  const proxy = createHttpProxy({
    securityToken: config.securityToken,
    baseUrl: config.baseUrl,
    port: config.port,
  });

  return createPgBossQueue(
    {
      connectionString: config.connectionString,
      jobPrefix: config.jobPrefix,
      queueConcurrency: config.queueConcurrency,
    },
    proxy
  );
}
