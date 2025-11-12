import PgBoss from 'pg-boss';
import { MessageData, type QueueDriver } from './types.js';

export interface ProxyFunctions {
  proxyWorkflow: (message: MessageData) => Promise<Response>;
  proxyStep: (message: MessageData) => Promise<Response>;
}

/**
 * Base QueueDriver implementation using pg-boss for job management.
 * Accepts a proxy implementation that handles the actual workflow/step execution.
 * This eliminates code duplication between HTTP and function-based proxies.
 */
export function createPgBossQueue(
  config: {
    connectionString: string;
    jobPrefix?: string;
    queueConcurrency?: number;
  },
  proxy: ProxyFunctions
): QueueDriver {
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
          const response = await proxy.proxyWorkflow(message);

          // TODO: Properly handle sleep
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
            throw new Error(`Workflow failed: ${text}`);
          }
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
          const response = await proxy.proxyStep(message);

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

      for (let i = 0; i < (config.queueConcurrency || 10); i++) {
        await boss.work(workflowQueueName, workflowHandler);
        await boss.work(stepQueueName, stepHandler);
      }
    },
  };
}
