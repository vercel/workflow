import type { Storage, World } from '@workflow/world';
import createPostgres from 'postgres';
import { loadWorldConfig, type PostgresWorldConfig } from './config.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createFunctionProxy } from './proxies/function-proxy.js';
import { createHttpProxy } from './proxies/http-proxy.js';
import { createQueue } from './queue.js';
import {
  createGraphileWorkerFunctionProxyQueue,
  createGraphileWorkerHttpProxyQueue,
  createPgBossFunctionProxyQueue,
  createPgBossHttpProxyQueue,
} from './queue-drivers/factories.js';
import { createGraphileWorkerQueue } from './queue-drivers/graphile.js';
import { createPgBossQueue } from './queue-drivers/pgboss.js';
import type { QueueDriver } from './queue-drivers/types.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

/**
 * Get the default queue factory based on WORKFLOW_QUEUE_DRIVER env var.
 * Defaults to pg-boss for backwards compatibility.
 *
 * Set WORKFLOW_QUEUE_DRIVER=graphile to use Graphile Worker.
 */
function getDefaultQueueFactory(): () => QueueDriver {
  const driver = process.env.WORKFLOW_QUEUE_DRIVER || 'pgboss';

  if (driver === 'graphile') {
    return createGraphileWorkerHttpProxyQueue;
  }

  return createPgBossHttpProxyQueue;
}

export function createWorld(
  opts: PostgresWorldConfig = {}
): World & { start(): Promise<void> } {
  const config = loadWorldConfig(opts);

  const queueDriver = opts.queueFactory
    ? opts.queueFactory()
    : getDefaultQueueFactory()();

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

export type { PostgresWorldConfig } from './config.js';
// Re-export schema for users who want to extend or inspect the database schema
export * from './drizzle/schema.js';

export { createFunctionProxy, createHttpProxy };
export {
  createPgBossQueue,
  createPgBossFunctionProxyQueue,
  createPgBossHttpProxyQueue,
};
export {
  createGraphileWorkerQueue,
  createGraphileWorkerFunctionProxyQueue,
  createGraphileWorkerHttpProxyQueue,
};
