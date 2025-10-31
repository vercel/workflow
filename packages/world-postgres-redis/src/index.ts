import type { Storage, World } from '@workflow/world';
import { createClient as createRedisClient } from 'redis';
import createPostgres from 'postgres';
import type { PostgresRedisWorldConfig } from './config.js';
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

export function createWorld(
  config: PostgresRedisWorldConfig = {
    connectionString:
      process.env.WORKFLOW_POSTGRES_URL ||
      'postgres://world:world@localhost:5432/world',
    redisUrl:
      process.env.WORKFLOW_REDIS_URL || 'redis://127.0.0.1:6379',
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
    queueConcurrency:
      parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '10', 10) ||
      10,
  }
): World & { start(): Promise<void> } {
  const postgres = createPostgres(config.connectionString);
  const drizzle = createClient(postgres);
  const redis = createRedisClient({
    url: config.redisUrl,
  });
  const queue = createQueue(redis, config);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(redis);

  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      // Connect Redis first before starting queue workers
      await redis.connect();
      // Ensure connection is ready
      if (!redis.isOpen) {
        throw new Error('Failed to connect to Redis');
      }
      await queue.start();
    },
  };
}
