import { setTimeout } from 'node:timers/promises';
import { JsonTransport } from '@vercel/queue';
import { MessageId, type Queue, ValidQueueName } from '@workflow/world';
import { Sema } from 'async-sema';
import { monotonicFactory } from 'ulid';
import { Agent } from 'undici';
import z from 'zod';
import type { Config } from './config.js';
import { resolveBaseUrl } from './config.js';
import { PACKAGE_VERSION } from './init.js';

// For local queue, there is no technical limit on the message visibility lifespan,
// but the environment variable can be used for testing purposes to set a max visibility limit.
const LOCAL_QUEUE_MAX_VISIBILITY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_MAX_VISIBILITY ?? '0', 10) ||
  Infinity;

// The local workers share the same Node.js process and event loop,
// so we need to limit concurrency to avoid overwhelming the system.
const DEFAULT_CONCURRENCY_LIMIT = 100;
const WORKFLOW_LOCAL_QUEUE_CONCURRENCY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY ?? '0', 10) ||
  DEFAULT_CONCURRENCY_LIMIT;

// Create a custom agent optimized for high-concurrency local workflows:
// - headersTimeout: 0 allows long-running steps
// - connections: 100 allows many parallel connections to the same host
// - pipelining: 1 (default) for HTTP/1.1 compatibility
// - keepAliveTimeout: 30s keeps connections warm for rapid step execution
const httpAgent = new Agent({
  headersTimeout: 0,
  connections: 100,
  keepAliveTimeout: 30_000,
});

export function createQueue(config: Partial<Config>): Queue {
  const transport = new JsonTransport();
  const generateId = monotonicFactory();
  const semaphore = new Sema(WORKFLOW_LOCAL_QUEUE_CONCURRENCY);

  /**
   * holds inflight messages by idempotency key to ensure
   * that we don't queue the same message multiple times
   */
  const inflightMessages = new Map<string, MessageId>();

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const cleanup = [] as (() => void)[];

    if (opts?.idempotencyKey) {
      const existing = inflightMessages.get(opts.idempotencyKey);
      if (existing) {
        return { messageId: existing };
      }
    }

    const body = transport.serialize(message);
    let pathname: string;
    if (queueName.startsWith('__wkf_step_')) {
      pathname = `step`;
    } else if (queueName.startsWith('__wkf_workflow_')) {
      pathname = `flow`;
    } else {
      throw new Error('Unknown queue name prefix');
    }
    const messageId = MessageId.parse(`msg_${generateId()}`);

    if (opts?.idempotencyKey) {
      const key = opts.idempotencyKey;
      inflightMessages.set(key, messageId);
      cleanup.push(() => {
        inflightMessages.delete(key);
      });
    }

    (async () => {
      const token = semaphore.tryAcquire();
      if (!token) {
        console.warn(
          `[world-local]: concurrency limit (${WORKFLOW_LOCAL_QUEUE_CONCURRENCY}) reached, waiting for queue to free up`
        );
        await semaphore.acquire();
      }
      try {
        let defaultRetriesLeft = 3;
        const baseUrl = await resolveBaseUrl(config);
        for (let attempt = 0; defaultRetriesLeft > 0; attempt++) {
          defaultRetriesLeft--;

          const response = await fetch(
            `${baseUrl}/.well-known/workflow/v1/${pathname}`,
            {
              method: 'POST',
              duplex: 'half',
              dispatcher: httpAgent,
              headers: {
                'content-type': 'application/json',
                'x-vqs-queue-name': queueName,
                'x-vqs-message-id': messageId,
                'x-vqs-message-attempt': String(attempt + 1),
              },
              body,
            }
          );

          if (response.ok) {
            return;
          }

          const text = await response.text();

          if (response.status === 503) {
            try {
              const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
              await setTimeout(timeoutSeconds * 1000);
              defaultRetriesLeft++;
              continue;
            } catch {}
          }

          console.error(`[local world] Failed to queue message`, {
            queueName,
            text,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: body.toString(),
          });
        }

        console.error(
          `[local world] Reached max retries of local world queue implementation`
        );
      } finally {
        semaphore.release();
      }
    })()
      .catch((err) => {
        // Silently ignore client disconnect errors (e.g., browser refresh during streaming)
        // These are expected and should not cause unhandled rejection warnings
        const isAbortError =
          err?.name === 'AbortError' || err?.name === 'ResponseAborted';
        if (!isAbortError) {
          console.error('[local world] Queue operation failed:', err);
        }
      })
      .finally(() => {
        for (const fn of cleanup) {
          fn();
        }
      });

    return { messageId };
  };

  const HeaderParser = z.object({
    'x-vqs-queue-name': ValidQueueName,
    'x-vqs-message-id': MessageId,
    'x-vqs-message-attempt': z.coerce.number(),
  });

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    return async (req) => {
      const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));

      if (!headers.success || !req.body) {
        return Response.json(
          {
            error: !req.body
              ? 'Missing request body'
              : 'Missing required headers',
          },
          { status: 400 }
        );
      }

      const queueName = headers.data['x-vqs-queue-name'];
      const messageId = headers.data['x-vqs-message-id'];
      const attempt = headers.data['x-vqs-message-attempt'];

      if (!queueName.startsWith(prefix)) {
        return Response.json({ error: 'Unhandled queue' }, { status: 400 });
      }

      const body = await new JsonTransport().deserialize(req.body);
      try {
        const result = await handler(body, { attempt, queueName, messageId });

        let timeoutSeconds: number | null = null;
        if (typeof result?.timeoutSeconds === 'number') {
          timeoutSeconds = Math.min(
            result.timeoutSeconds,
            LOCAL_QUEUE_MAX_VISIBILITY
          );
        }

        if (timeoutSeconds) {
          return Response.json({ timeoutSeconds }, { status: 503 });
        }

        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      }
    };
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return `dpl_local@${PACKAGE_VERSION}`;
  };

  return { queue, createQueueHandler, getDeploymentId };
}
