import type { Storage, World } from '@workflow/world';
import createPostgres from 'postgres';
import type { PostgresWorldConfig } from './config.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createFunctionProxy } from './proxies/function-proxy.js';
import { createHttpProxy } from './proxies/http-proxy.js';
import { createQueue } from './queue.js';
import {
  createPgBossFunctionProxyQueue,
  createPgBossHttpProxyQueue,
} from './queue-drivers/factories.js';
import { createPgBossQueue } from './queue-drivers/pgboss.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

export const DEFAULT_PG_URL = 'postgres://world:world@localhost:5432/world';

export function createWorld(
  config: PostgresWorldConfig = {
    connectionString: process.env.WORKFLOW_POSTGRES_URL || DEFAULT_PG_URL,
    securityToken: process.env.WORKFLOW_POSTGRES_SECURITY_TOKEN || 'secret',
    queueFactory: defaultQueueFactory,
  }
): World & { start(): Promise<void> } {
  const queueDriver = config.queueFactory();
  const postgres = createPostgres(config.connectionString);
  const drizzle = createClient(postgres);

  const storage = createStorage(drizzle);
  const queue = createQueue(queueDriver, config.securityToken);
  const streamer = createStreamer(postgres, drizzle);

  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      await queueDriver.start();
    },
  };
}

function createStorage(drizzle: Drizzle): Storage {
  return {
    runs: createRunsStorage(drizzle),
    events: createEventsStorage(drizzle),
    hooks: createHooksStorage(drizzle),
    steps: createStepsStorage(drizzle),
  };
}

function defaultQueueFactory() {
  return createPgBossHttpProxyQueue({
    baseUrl: process.env.WORKFLOW_POSTGRES_BASE_URL,
    connectionString: process.env.WORKFLOW_POSTGRES_URL || DEFAULT_PG_URL,
    securityToken:
      process.env.WORKFLOW_POSTGRES_SECURITY_TOKEN || 'this-is-not-safe',
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
    queueConcurrency:
      parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '10', 10) ||
      10,
  });
}

export type { PostgresWorldConfig } from './config.js';
// Re-export schema for users who want to extend or inspect the database schema
export * from './drizzle/schema.js';

export { createFunctionProxy, createHttpProxy };
export {
  createPgBossQueue,
  createPgBossFunctionProxyQueue as createPgBossFunctionProxy,
  createPgBossHttpProxyQueue as createPgBossHttpProxy,
};
