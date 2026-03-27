import type { Storage, ValidQueueName, World } from '@workflow/world';
import { Pool } from 'pg';
import type { PostgresWorldConfig } from './config.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import type { PostgresQueue } from './queue.js';
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

/**
 * Re-enqueue all active (pending/running) workflow runs so they resume
 * processing after a world restart. Graphile-worker handles pending jobs
 * automatically, but runs whose jobs exhausted all retry attempts or were
 * lost during shutdown need to be re-enqueued. The workflow handler is
 * idempotent (event-log replay), so duplicate enqueues are safe.
 */
async function reenqueueActiveRuns(
  runs: Storage['runs'],
  queue: PostgresQueue
): Promise<void> {
  let reenqueued = 0;
  for (const status of ['pending', 'running'] as const) {
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = await runs.list({
        status,
        resolveData: 'none',
        pagination: { cursor },
      });
      for (const run of page.data) {
        const queueName: ValidQueueName = `__wkf_workflow_${run.workflowName}`;
        await queue.queue(queueName, { runId: run.runId });
        reenqueued++;
      }
      hasMore = page.hasMore;
      cursor = page.cursor ?? undefined;
    }
  }
  if (reenqueued > 0) {
    console.log(
      `[world-postgres] Re-enqueued ${reenqueued} active run(s) on startup`
    );
  }
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
  const pool =
    config.pool ||
    new Pool({
      connectionString:
        config.connectionString ||
        'postgres://world:world@localhost:5432/world',
      ...(maxPoolSize !== undefined ? { max: maxPoolSize } : {}),
    });

  const drizzle = createClient(pool);
  const queue = createQueue(config, pool);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(pool, drizzle);

  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      await queue.start();
      await reenqueueActiveRuns(storage.runs, queue);
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
