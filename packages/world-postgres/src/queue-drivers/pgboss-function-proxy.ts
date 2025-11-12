import { createPgBossQueue } from './pgboss-base.js';
import type { QueueDriver } from './types.js';
import { createFunctionProxy } from './wkf-function-proxy.js';

export interface PgBossFunctionProxyConfig {
  connectionString: string;
  securityToken: string;
  jobPrefix?: string;
  queueConcurrency?: number;
  workflowEntrypoint: (request: Request) => Promise<Response>;
  stepEntrypoint: (request: Request) => Promise<Response>;
}

/**
 * QueueDriver implementation using pg-boss for job management and direct function calls for execution.
 * Workers call entrypoint functions directly in-process without HTTP overhead.
 */
export function createPgBossFunctionProxy(
  config: PgBossFunctionProxyConfig
): QueueDriver {
  const proxy = createFunctionProxy({
    securityToken: config.securityToken,
    workflowEntrypoint: config.workflowEntrypoint,
    stepEntrypoint: config.stepEntrypoint,
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
