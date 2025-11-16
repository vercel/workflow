import { getQueueConfig, getWorldConfig } from '../config.js';
import { createFunctionProxy } from '../proxies/function-proxy.js';
import { createHttpProxy } from '../proxies/http-proxy.js';
import { createPgBossQueue } from './pgboss.js';
import type { QueueDriver } from './types.js';

/**
 * QueueDriver implementation using pg-boss for job management
 * and direct function calls for execution.
 */
export function createPgBossFunctionProxyQueue(opts: {
  jobPrefix?: string;
  securityToken?: string;
  connectionString?: string;
  queueConcurrency?: number;
  stepEntrypoint: (request: Request) => Promise<Response>;
  workflowEntrypoint: (request: Request) => Promise<Response>;
}): QueueDriver {
  const worldDefaults = getWorldConfig();
  const queueDefaults = getQueueConfig();

  const config = {
    connectionString: opts.connectionString ?? worldDefaults.connectionString,
    securityToken: opts.securityToken ?? worldDefaults.securityToken,
    jobPrefix: opts.jobPrefix ?? queueDefaults.jobPrefix,
    queueConcurrency: opts.queueConcurrency ?? queueDefaults.queueConcurrency,
  };

  return createPgBossQueue(
    {
      jobPrefix: config.jobPrefix,
      connectionString: config.connectionString,
      queueConcurrency: config.queueConcurrency,
    },
    createFunctionProxy({
      securityToken: config.securityToken,
      stepEntrypoint: opts.stepEntrypoint,
      workflowEntrypoint: opts.workflowEntrypoint,
    })
  );
}

/**
 * QueueDriver implementation using pg-boss for job management
 * and HTTP for execution.
 */
export function createPgBossHttpProxyQueue(
  opts: {
    port?: number;
    baseUrl?: string;
    jobPrefix?: string;
    securityToken?: string;
    connectionString?: string;
    queueConcurrency?: number;
  } = {}
): QueueDriver {
  const worldDefaults = getWorldConfig();
  const queueDefaults = getQueueConfig();

  const config = {
    connectionString: opts.connectionString ?? worldDefaults.connectionString,
    securityToken: opts.securityToken ?? worldDefaults.securityToken,
    jobPrefix: opts.jobPrefix ?? queueDefaults.jobPrefix,
    queueConcurrency: opts.queueConcurrency ?? queueDefaults.queueConcurrency,

    port:
      opts.port ??
      (process.env.WORKFLOW_POSTGRES_APP_PORT
        ? parseInt(process.env.WORKFLOW_POSTGRES_APP_PORT, 10)
        : undefined),

    baseUrl: opts.baseUrl ?? process.env.WORKFLOW_POSTGRES_APP_URL,
  };

  return createPgBossQueue(
    {
      jobPrefix: config.jobPrefix,
      connectionString: config.connectionString,
      queueConcurrency: config.queueConcurrency,
    },
    createHttpProxy({
      port: config.port,
      baseUrl: config.baseUrl,
      securityToken: config.securityToken,
    })
  );
}
