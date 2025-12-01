import {
  makeWorkerUtils,
  run,
  type Task,
  type WorkerUtils,
} from 'graphile-worker';
import type { WkfProxy } from '../proxies/types.js';
import { MessageData, type QueueDriver } from './types.js';

/**
 * QueueDriver implementation using Graphile Worker for job management.
 * Uses PostgreSQL LISTEN/NOTIFY for near-instant job pickup (~3ms latency).
 * Takes in a proxy that will handle the actual step/flow execution.
 */
export function createGraphileWorkerQueue(
  opts: {
    jobPrefix: string;
    connectionString: string;
    queueConcurrency: number;
  },
  proxy: WkfProxy
): QueueDriver {
  let workerUtils: WorkerUtils | null = null;

  const stepTaskName = `${opts.jobPrefix}step`;
  const flowTaskName = `${opts.jobPrefix}flow`;

  const ensureUtils = async (): Promise<WorkerUtils> => {
    if (!workerUtils) {
      workerUtils = await makeWorkerUtils({
        connectionString: opts.connectionString,
      });
      await workerUtils.migrate();
    }
    return workerUtils;
  };

  const createTaskHandler = (
    proxyFn: WkfProxy[keyof WkfProxy],
    taskName: string
  ): Task => {
    return async (payload, helpers) => {
      const message = MessageData.parse(payload);

      helpers.logger.info(`Running: ${message.queueName}`);

      try {
        const response = await proxyFn(message);

        if (response.status === 503) {
          const body = (await response.json()) as { timeoutSeconds?: number };

          if (body.timeoutSeconds) {
            // Requeue the job with a delay
            const utils = await ensureUtils();
            await utils.addJob(taskName, MessageData.encode(message), {
              jobKey: message.idempotencyKey ?? message.messageId,
              maxAttempts: 3,
              runAt: new Date(Date.now() + body.timeoutSeconds * 1000),
            });

            helpers.logger.info(
              `Requeued: ${message.queueName} for ${body.timeoutSeconds}s`
            );

            return;
          }
        }

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Step failed: ${text}`);
        }
      } catch (error) {
        helpers.logger.error(`Error handling: ${message.queueName}`, { error });
        throw error;
      }
    };
  };

  return {
    pushStep: async (message: MessageData) => {
      const utils = await ensureUtils();
      await utils.addJob(stepTaskName, MessageData.encode(message), {
        jobKey: message.idempotencyKey ?? message.messageId,
        maxAttempts: 3,
      });
    },

    pushFlow: async (message: MessageData) => {
      const utils = await ensureUtils();
      await utils.addJob(flowTaskName, MessageData.encode(message), {
        jobKey: message.idempotencyKey ?? message.messageId,
        maxAttempts: 3,
      });
    },

    start: async () => {
      await ensureUtils();

      await run({
        connectionString: opts.connectionString,
        concurrency: opts.queueConcurrency,
        taskList: {
          [stepTaskName]: createTaskHandler(proxy.proxyStep, stepTaskName),
          [flowTaskName]: createTaskHandler(proxy.proxyWorkflow, flowTaskName),
        },
      });
    },
  };
}
