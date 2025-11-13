import PgBoss from 'pg-boss';
import type { WkfProxy } from '../proxies/types.js';
import { MessageData, type QueueDriver } from './types.js';

/**
 * Base QueueDriver implementation using pg-boss for job management.
 * Takes in a proxy that will handle the actual step/flow execution.
 */
export function createPgBossQueue(
  opts: {
    jobPrefix: string;
    connectionString: string;
    queueConcurrency: number;
  },
  proxy: WkfProxy
): QueueDriver {
  let startPromise: Promise<unknown> | null = null;
  const boss = new PgBoss(opts.connectionString);

  const stepQueueName = `${opts.jobPrefix}steps`;
  const workflowQueueName = `${opts.jobPrefix}flows`;

  const ensureStarted = async () => {
    if (!startPromise) {
      startPromise = boss.start().then(() => {
        return Promise.all([
          boss.createQueue(workflowQueueName),
          boss.createQueue(stepQueueName),
        ]);
      });
    }

    await startPromise;
  };

  return {
    pushStep: async (message: MessageData) => {
      await ensureStarted();

      await boss.send(stepQueueName, MessageData.encode(message), {
        singletonKey: message?.idempotencyKey ?? message.messageId,
        retryLimit: 3,
      });
    },

    pushFlow: async (message: MessageData) => {
      await ensureStarted();

      await boss.send(workflowQueueName, MessageData.encode(message), {
        singletonKey: message?.idempotencyKey ?? message.messageId,
        retryLimit: 3,
      });
    },

    start: async () => {
      await ensureStarted();

      const stepWorker = createWorker(proxy.proxyStep);
      const workflowWorker = createWorker(proxy.proxyWorkflow);

      for (let i = 0; i < opts.queueConcurrency; i++) {
        await boss.work(workflowQueueName, workflowWorker);
        await boss.work(stepQueueName, stepWorker);
      }
    },
  };
}

function createWorker(proxy: WkfProxy[keyof WkfProxy]) {
  return async ([job]: PgBoss.Job[]) => {
    const message = MessageData.parse(job.data);

    console.log(`[${job.id}] running: ${message.queueName}`);

    try {
      const response = await proxy(message);

      // TODO: Properly handle 503
      if (response.status === 503) {
        const body = (await response.json()) as {
          timeoutSeconds?: number;
        };
        if (body.timeoutSeconds) {
          throw new Error(`Retry after ${body.timeoutSeconds}s`);
        }
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Step failed: ${text}`);
      }
    } catch (error) {
      console.error(
        `[${job.id}] Error handling step: ${message.queueName}`,
        error
      );
      throw error;
    }
  };
}
