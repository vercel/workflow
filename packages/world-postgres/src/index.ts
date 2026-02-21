import type { Socket } from 'node:net';
import type { Storage, World } from '@workflow/world';
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
  const postgres = createPostgres(config.connectionString);
  const drizzle = createClient(postgres);
  const queue = createQueue(config, postgres);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(postgres, drizzle);

  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      await queue.start();
    },
    async close() {
      await streamer.close();
      await queue.close();
      await postgres.end();
      // Force-destroy any TCP sockets that survived postgres.end().
      // postgres.js's terminate() calls socket.end() (graceful TCP FIN)
      // rather than socket.destroy(), leaving sockets in FIN_WAIT state
      // that prevent the process from exiting on slower networks (e.g.
      // CI Docker containers).
      // See: https://github.com/porsager/postgres/issues/1022
      for (const h of (process as any)._getActiveHandles?.() ?? []) {
        if (h?.constructor?.name === 'Socket' && !h._type && !h.destroyed) {
          (h as Socket).destroy();
        }
      }
    },
  };
}

// Re-export schema for users who want to extend or inspect the database schema
export type { PostgresWorldConfig } from './config.js';
export * from './drizzle/schema.js';
