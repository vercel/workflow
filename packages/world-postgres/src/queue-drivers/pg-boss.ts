import PgBoss from 'pg-boss';
import type { QueueConfig } from '../config.js';
import { MessageData } from './types.js';
import { proxyStep, proxyWorkflow } from './wkf-proxy.js';

export function createPgBossQueue(config: QueueConfig) {
  let startPromise: Promise<unknown> | null = null;
  const boss = new PgBoss(config.connectionString);

  const stepQueueName = 'workflow_steps';
  const workflowQueueName = 'workflow_flows';

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

      const workflowHandler = async ([job]: PgBoss.Job[]) => {
        const message = MessageData.parse(job.data);

        console.log(`[${job.id}] running: ${message.queueName}`);

        try {
          await proxyWorkflow(message);
        } catch (error) {
          console.error(
            `[${job.id}] Error handling workflow: ${message.queueName}`,
            error
          );
          throw error;
        }
      };

      const stepHandler = async ([job]: PgBoss.Job[]) => {
        const message = MessageData.parse(job.data);

        console.log(`[${job.id}] running: ${message.queueName}`);

        try {
          await proxyStep(message);
        } catch (error) {
          console.error(
            `[${job.id}] Error handling step: ${message.queueName}`,
            error
          );
          throw error;
        }
      };

      for (let i = 0; i < (config.queueConcurrency || 10); i++) {
        await boss.work(workflowQueueName, workflowHandler);
        await boss.work(stepQueueName, stepHandler);
      }
    },
  };
}
