import type { StartOptions, Storage, World } from '@workflow/world';
import {
  cancelActiveRuns,
  reenqueueActiveRuns,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
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

function getDefaultConnectionString(): string {
  return (
    process.env.WORKFLOW_POSTGRES_URL ||
    process.env.DATABASE_URL ||
    'postgres://world:world@localhost:5432/world'
  );
}

export function createWorld(
  config: PostgresWorldConfig = {
    connectionString: getDefaultConnectionString(),
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
    queueConcurrency:
      parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '50', 10) ||
      50,
  }
): World & { start(options?: StartOptions): Promise<void> } {
  const maxPoolSize = config.maxPoolSize ?? getDefaultMaxPoolSize();
  const pool =
    config.pool ||
    new Pool({
      connectionString: config.connectionString || getDefaultConnectionString(),
      ...(maxPoolSize !== undefined ? { max: maxPoolSize } : {}),
    });

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
    async start(options?: StartOptions) {
      // Boot-time recovery assumes this database's workflow schema belongs to
      // ONE app: `runs` has no namespace/tenant column (`config.namespace`
      // only prefixes queue topics), so both branches below operate on every
      // pending/running run in the database. An app sharing the schema with
      // other apps/namespaces must not run boot recovery — set
      // WORKFLOW_SKIP_BOOT_RECOVERY=1 (→ onRestart: 'ignore') on it.
      // Namespace-attributed storage is tracked in vercel/workflow#2978.
      const onRestart = options?.onRestart ?? 'recover';
      if (onRestart === 'cancel') {
        // Cancel BEFORE booting the worker so it can't begin draining a run we
        // are about to cancel. Old durable jobs that later fire will find the
        // run terminal and no-op. Then start the worker so NEW (dev) runs still
        // process.
        await cancelActiveRuns(storage.runs, storage.events, 'world-postgres');
        await queue.start();
        return;
      }
      await queue.start();
      if (onRestart === 'recover') {
        await reenqueueActiveRuns(
          storage.runs,
          queue.queue,
          'world-postgres',
          config.namespace
        );
      }
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

// Re-export schema for users who want to extend or inspect the database schema
export type { PostgresWorldConfig } from './config.js';
export * from './drizzle/schema.js';
