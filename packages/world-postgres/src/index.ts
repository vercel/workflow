import type { AuthProvider, Storage, World } from '@workflow/world';
import PgBoss from 'pg-boss';
import createPostgres from 'postgres';
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

function createAuthProvider(
  _config: PostgresWorldConfig,
  boss: PgBoss
): AuthProvider {
  return {
    async getAuthInfo() {
      return {
        environment: 'postgres',
        ownerId: 'postgres',
        projectId: 'postgres',
      };
    },
    async checkHealth() {
      try {
        if (!(await boss.isInstalled())) {
          throw new Error('Postgres Boss is not installed properly');
        }
      } catch (err) {
        return {
          success: false,
          data: { healthy: false },
          message:
            err &&
            typeof err === 'object' &&
            'message' in err &&
            typeof err.message === 'string'
              ? err.message
              : String(err),
        };
      }
      return {
        success: true,
        message: 'Postgres connection is healthy',
        data: { healthy: true },
      };
    },
  };
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
  const boss = new PgBoss({
    connectionString: config.connectionString,
  });
  const postgres = createPostgres(config.connectionString);
  const drizzle = createClient(postgres);
  const queue = createQueue(boss, config);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(postgres, drizzle);
  const auth = createAuthProvider(config, boss);

  return {
    ...storage,
    ...streamer,
    ...auth,
    ...queue,
    async start() {
      await queue.start();
    },
  };
}
