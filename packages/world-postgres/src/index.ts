import type { Storage, World } from '@workflow/world';
import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';
import { Pool } from 'pg';
import type { PostgresWorldConfig } from './config.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createQueue } from './queue.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(drizzle: Drizzle): Storage {
  return {
    runs: createRunsStorage(drizzle),
    events: createEventsStorage(drizzle),
    hooks: createHooksStorage(drizzle),
    steps: createStepsStorage(drizzle),
  };
}

function getDefaultMaxPoolSize(): number | undefined {
  const parsed = parseInt(
    process.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE || '',
    10
  );

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function createWorld(
  config: PostgresWorldConfig = {
    connectionString:
      process.env.WORKFLOW_POSTGRES_URL ||
      'postgres://world:world@localhost:5432/world',
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
    queueConcurrency:
      parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '10', 10) ||
      10,
  }
): World & { start(): Promise<void> } {
  const maxPoolSize = config.maxPoolSize ?? getDefaultMaxPoolSize();
  const pool = config.pool || createOwnedPool(config, maxPoolSize);

  const drizzle = createClient(pool);
  const queue = createQueue(config, pool);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(pool, drizzle);

  return {
    specVersion: SPEC_VERSION_CURRENT,
    ...storage,
    ...streamer,
    ...queue,
    ...(config.streamFlushIntervalMs !== undefined && {
      streamFlushIntervalMs: config.streamFlushIntervalMs,
    }),
    async start() {
      await queue.start();
      await reenqueueActiveRuns(
        storage.runs,
        queue.queue,
        'world-postgres',
        config.namespace
      );
    },
    async close() {
      await streamer.close();
      await queue.close();
      if (pool !== config.pool) {
        await pool.end();
      }
    },
  };
}

/**
 * The pool the World creates when the caller passes none.
 *
 * It listens for `error`: pg-pool re-emits an idle client's connection error
 * (a database restart, `pg_terminate_backend`) on the pool, and an
 * EventEmitter with no `error` listener throws it as an uncaught exception.
 * Graphile Worker listens only while the queue runs, and `pool.end()`
 * resolves before its idle clients have closed, so without this a backend
 * terminated during or after `close()` ends the process. The dropped client is
 * already out of the pool, and the next query opens a new one.
 */
function createOwnedPool(
  config: PostgresWorldConfig,
  maxPoolSize: number | undefined
): Pool {
  const pool = new Pool({
    connectionString:
      config.connectionString || 'postgres://world:world@localhost:5432/world',
    ...(maxPoolSize !== undefined ? { max: maxPoolSize } : {}),
  });
  pool.on('error', (error) => {
    console.warn(
      `[world-postgres] idle database connection closed: ${error.message}`
    );
  });
  return pool;
}

// Re-export schema for users who want to extend or inspect the database schema
export type { PostgresWorldConfig } from './config.js';
export * from './drizzle/schema.js';
