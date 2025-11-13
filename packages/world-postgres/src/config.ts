import type { QueueDriver } from './queue-drivers/types.js';

export type BaseWorldConfig = {
  connectionString?: string;
  securityToken?: string;
};

export type PostgresWorldConfig = BaseWorldConfig & {
  queueFactory?: () => QueueDriver;
};

export type ResolvedBaseWorldConfig = Required<BaseWorldConfig>;

export const DEFAULT_PG_URL = 'postgres://world:world@localhost:5432/world';
export const DEFAULT_SECURITY_TOKEN = 'secret';
export const DEFAULT_JOB_PREFIX = 'workflow_';
export const DEFAULT_QUEUE_CONCURRENCY = 10;

let worldConfig: ResolvedBaseWorldConfig | null = null;

export function loadWorldConfig(
  config: BaseWorldConfig = {}
): ResolvedBaseWorldConfig {
  worldConfig = {
    connectionString:
      config.connectionString ??
      process.env.WORKFLOW_POSTGRES_URL ??
      process.env.DATABASE_URL ??
      DEFAULT_PG_URL,

    securityToken:
      config.securityToken ??
      process.env.WORKFLOW_POSTGRES_SECURITY_TOKEN ??
      DEFAULT_SECURITY_TOKEN,
  };

  return worldConfig;
}

export function getWorldConfig(): ResolvedBaseWorldConfig {
  if (!worldConfig) {
    throw new Error(
      'World config not loaded. Call createWorld() or loadWorldConfig().'
    );
  }

  return worldConfig;
}

export function getQueueConfig() {
  return {
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX ?? DEFAULT_JOB_PREFIX,
    queueConcurrency:
      (process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY
        ? parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY, 10)
        : undefined) ?? DEFAULT_QUEUE_CONCURRENCY,
  };
}
