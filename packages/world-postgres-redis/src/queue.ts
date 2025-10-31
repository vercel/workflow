import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createEmbeddedWorld } from '@workflow/world-local';
import type { RedisClientType, RedisScripts, RedisFunctions, RedisDefaultModules } from 'redis';
import { monotonicFactory } from 'ulid';
import { MessageData } from './zod.js';
import type { PostgresWorldConfig } from './config.js';

/**
 * The Redis queue works by creating two Redis lists (one for workflows, one for steps):
 * - `${prefix}flows` for workflow jobs
 * - `${prefix}steps` for step jobs
 *
 * When a message is queued, it is LPUSHed to the appropriate Redis list with idempotency tracking.
 * Workers RPOP messages from lists and forward them to the _embedded world_, showing that
 * we can reuse the embedded world, mix and match worlds to build
 * hybrid architectures, and even migrate between worlds.
 */
export function createQueue(
  redis: RedisClientType<RedisDefaultModules, RedisFunctions, RedisScripts>,
  config: PostgresWorldConfig
): Queue & { start(): Promise<void> } {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createEmbeddedWorld({ dataDir: undefined, port });

  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const createQueueHandler = embeddedWorld.createQueueHandler;

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'postgres-redis';
  };

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    // Ensure Redis is connected (idempotent - safe to call multiple times)
    if (!redis.isOpen) {
      await redis.connect();
    }
    const [qPrefix, id] = parseQueueName(queueName);
    const listKey = Queues[qPrefix];
    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    
    // Use idempotency key to prevent duplicate processing (like pg-boss singletonKey)
    // Implementation uses Redis Set data structure with SADD for atomic check-and-add
    const idempotencyKey = opts?.idempotencyKey ?? messageId;
    const idempotencySetKey = `${listKey}:idempotent`;
    
    // Atomically check and add - SADD returns number of elements added (0 if already exists)
    // This prevents duplicate messages from being queued
    const added = await redis.sAdd(idempotencySetKey, idempotencyKey);
    if (added === 0) {
      // Already queued with this idempotency key, return early to prevent duplicate processing
      return { messageId };
    }
    
    // Set TTL on the Set (10 minutes) to prevent memory leaks
    // Note: TTL is fixed duration, not tied to actual job completion time
    await redis.expire(idempotencySetKey, 600);
    
    const messageData: MessageData = {
      id,
      data: Buffer.from(body).toString('base64'),
      idempotencyKey: opts?.idempotencyKey,
      messageId,
      attempt: 1,
    };
    // Validate before stringifying
    const validated = MessageData.parse(messageData);
    const payload = JSON.stringify(validated);
    
    // Pipeline operations for better performance (Redis executes atomically)
    await redis
      .multi()
      .lPush(listKey, payload)
      .publish(`chan:${listKey}`, 'new')
      .exec();
    return { messageId };
  };

  async function worker(queuePrefix: QueuePrefix, listKey: string) {
    // Each worker uses its own Redis client because BRPOP blocks the connection
    const workerRedis = redis.duplicate();
    await workerRedis.connect();
    
    try {
    while (true) {
        // Use BRPOP to wait for items; blocks indefinitely with timeout=0
        const result = await workerRedis.brPop(listKey, 0);

        if (!result) {
          // Should not happen with timeout=0, but handle gracefully
          continue;
        }

        const item = result.element;

      try {
        const parsedJson = JSON.parse(item as string);
        const parsed = MessageData.parse(parsedJson);
        const body = Buffer.from(parsed.data, 'base64');
        const decoded = await transport.deserialize(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body);
              controller.close();
            },
          })
        );
        const message = QueuePayloadSchema.parse(decoded);
        const queueName = `${queuePrefix}${parsed.id}` as const;
        // embeddedWorld.queue() is fire-and-forget and handles retries internally
        await embeddedWorld.queue(queueName, message, {
          idempotencyKey: parsed.idempotencyKey,
        });
      } catch (error) {
        // Log parsing/deserialization errors but continue processing
        // This prevents worker crashes from malformed messages
        console.error(`[Redis Queue] Error processing message from ${listKey}:`, error);
      }
      
      // Note: idempotency key is automatically cleaned up via TTL (10 minutes, set when added)
      }
    } finally {
      await workerRedis.quit();
    }
  }

  async function startWorkers() {
    const concurrency = config.queueConcurrency || 10;
    const entries = Object.entries(Queues) as [QueuePrefix, string][];
    await Promise.all(
      entries.flatMap(([queuePrefix, listKey]) =>
        Array.from({ length: concurrency }, () => worker(queuePrefix, listKey))
      )
    );
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    async start() {
      // workers run in background
      void startWorkers();
    },
  };
}

const parseQueueName = (name: ValidQueueName): [QueuePrefix, string] => {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) {
      return [prefix, name.slice(prefix.length)];
    }
  }
  throw new Error(`Invalid queue name: ${name}`);
};
