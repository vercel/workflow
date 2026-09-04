import type { Storage, World } from '@workflow/world';
import { mintedSpecVersion, reenqueueActiveRuns } from '@workflow/world';
import { Pool } from 'pg';
import {
  type PostgresWorldConfig,
  type PostgresWorldRole,
  PostgresWorldRoleSchema,
} from './config.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createQueue } from './queue.js';
import {
  createRunStatusListener,
  type RunStatusListener,
} from './run-status.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(
  drizzle: Drizzle,
  runStatusListener: RunStatusListener
): Storage {
  return {
    runs: createRunsStorage(drizzle, runStatusListener),
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
    applicationManagedShutdown:
      process.env.WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN === '1',
  }
): World & { start(): Promise<void> } {
  const maxPoolSize = config.maxPoolSize ?? getDefaultMaxPoolSize();
  const pool =
    config.pool ||
    new Pool({
      connectionString: config.connectionString || getDefaultConnectionString(),
      ...(maxPoolSize !== undefined ? { max: maxPoolSize } : {}),
    });

  // Role resolution order: the explicit option, then WORKFLOW_POSTGRES_ROLE,
  // then the worker default that every release before the option existed had.
  // An unrecognized environment value falls back to that default: the variable
  // is an escape hatch, not a hard requirement.
  const envRole = PostgresWorldRoleSchema.safeParse(
    process.env.WORKFLOW_POSTGRES_ROLE?.toLowerCase()
  );
  const role: PostgresWorldRole =
    config.role ??
    (envRole.success ? envRole.data : PostgresWorldRoleSchema.enum.worker);

  const drizzle = createClient(pool);
  const queue = createQueue(config, pool, role);
  // Opens its `LISTEN` connection lazily, on the first `waitForTerminalStatus`
  // call, so a deployment that never awaits a run never pays for it.
  const runStatusListener = createRunStatusListener(pool);
  const storage = createStorage(drizzle, runStatusListener);
  const streamer = createStreamer(pool, drizzle);

  return {
    specVersion: mintedSpecVersion(),
    capabilities: {
      hookRetention: { active: true },
    },
    ...storage,
    ...streamer,
    ...queue,
    ...(config.streamFlushIntervalMs !== undefined && {
      streamFlushIntervalMs: config.streamFlushIntervalMs,
    }),
    async start() {
      await queue.start();
      // A producer executes nothing, so recovering a run here would only hand
      // it to whichever process claims it next — including a peer that is
      // already replaying it.
      if (role === PostgresWorldRoleSchema.enum.producer) {
        return;
      }
      await reenqueueActiveRuns(
        storage.runs,
        queue.queue,
        'world-postgres',
        config.namespace
      );
    },
    async close() {
      await queue.close();
      await streamer.close();
      await runStatusListener.close();
      if (pool !== config.pool) {
        await pool.end();
      }
    },
  };
}

// Re-export schema for users who want to extend or inspect the database schema
export { PostgresWorldRoleSchema } from './config.js';
export type { PostgresWorldConfig, PostgresWorldRole } from './config.js';
export * from './drizzle/schema.js';
