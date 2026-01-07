import type {
  HealthCheckEndpoint,
  HealthCheckOptions,
  HealthCheckResult,
  Storage,
  World,
} from '@workflow/world';
import { HEALTH_CHECK_STREAM_PREFIX } from '@workflow/world';
import PgBoss from 'pg-boss';
import createPostgres from 'postgres';
import { monotonicFactory } from 'ulid';
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

/** Default timeout for health checks in milliseconds */
const DEFAULT_HEALTH_CHECK_TIMEOUT = 30_000;

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
  const boss = new PgBoss({
    connectionString: config.connectionString,
  });
  const postgres = createPostgres(config.connectionString);
  const drizzle = createClient(postgres);
  const queue = createQueue(boss, config);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(postgres, drizzle);
  const generateId = monotonicFactory();

  const healthCheck = async (
    endpoint: HealthCheckEndpoint,
    options?: HealthCheckOptions
  ): Promise<HealthCheckResult> => {
    const timeout = options?.timeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT;
    const correlationId = `hc_${generateId()}`;
    const streamName = `${HEALTH_CHECK_STREAM_PREFIX}${correlationId}`;

    // Determine which queue to use based on endpoint
    const queueName =
      endpoint === 'workflow'
        ? '__wkf_workflow___health_check__'
        : '__wkf_step___health_check__';

    try {
      // Send the health check message through the queue
      await queue.queue(queueName as `__wkf_workflow_${string}`, {
        __healthCheck: true,
        correlationId,
      });

      // Wait for the response with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Health check timed out after ${timeout}ms`));
        }, timeout);
      });

      const readStreamResponse = async (): Promise<HealthCheckResult> => {
        // Read from the stream - the handler will write to this when it receives the health check
        const stream = await streamer.readFromStream(streamName);
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];

        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) chunks.push(result.value);
        }

        // Parse the response
        const responseText = new TextDecoder().decode(
          Buffer.concat(chunks.map((c) => Buffer.from(c)))
        );
        const response = JSON.parse(responseText);

        return {
          healthy: response.healthy === true,
        };
      };

      return await Promise.race([readStreamResponse(), timeoutPromise]);
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    ...storage,
    ...streamer,
    ...queue,
    healthCheck,
    async start() {
      await queue.start();
    },
  };
}

// Re-export schema for users who want to extend or inspect the database schema
export type { PostgresWorldConfig } from './config.js';
export * from './drizzle/schema.js';
