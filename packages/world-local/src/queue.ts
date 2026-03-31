import { JsonTransport } from '@vercel/queue';
import { MessageId, type Queue, ValidQueueName } from '@workflow/world';
import { Sema } from 'async-sema';
import { monotonicFactory } from 'ulid';
import { Agent } from 'undici';
import z from 'zod';
import type { Config } from './config.js';
import { resolveBaseUrl } from './config.js';
import { getPackageInfo } from './init.js';

const LOCAL_QUEUE_MAX_VISIBILITY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_MAX_VISIBILITY ?? '0', 10) ||
  Infinity;

const DEFAULT_CONCURRENCY_LIMIT = 1000;
const WORKFLOW_LOCAL_QUEUE_CONCURRENCY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY ?? '0', 10) ||
  DEFAULT_CONCURRENCY_LIMIT;
const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;

export type DirectHandler = (req: Request) => Promise<Response>;

export type LocalQueue = Queue & {
  close(): Promise<void>;
  registerHandler(
    prefix: '__wkf_step_' | '__wkf_workflow_',
    handler: DirectHandler
  ): void;
};

type ScheduledMessage = {
  attempt: number;
  body: Uint8Array;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  messageId: MessageId;
  pendingExecution: boolean;
  queueName: ValidQueueName;
  remainingServerRetries: number;
  running: boolean;
  timer?: ReturnType<typeof globalThis.setTimeout>;
  version: number;
};

function getQueueRoute(queueName: ValidQueueName): {
  pathname: 'flow' | 'step';
  prefix: '__wkf_step_' | '__wkf_workflow_';
} {
  if (queueName.startsWith('__wkf_step_')) {
    return { pathname: 'step', prefix: '__wkf_step_' };
  }
  if (queueName.startsWith('__wkf_workflow_')) {
    return { pathname: 'flow', prefix: '__wkf_workflow_' };
  }
  throw new Error('Unknown queue name prefix');
}

export function createQueue(config: Partial<Config>): LocalQueue {
  const httpAgent = new Agent({
    headersTimeout: 0,
    connections: 1000,
    keepAliveTimeout: 30_000,
  });
  const transport = new JsonTransport();
  const generateId = monotonicFactory();
  const semaphore = new Sema(WORKFLOW_LOCAL_QUEUE_CONCURRENCY);
  const scheduledMessages = new Map<string, ScheduledMessage>();
  const directHandlers = new Map<string, DirectHandler>();
  let closed = false;

  const cleanupMessage = (message: ScheduledMessage) => {
    if (message.timer) {
      clearTimeout(message.timer);
      message.timer = undefined;
    }
    if (message.idempotencyKey) {
      scheduledMessages.delete(message.idempotencyKey);
    }
  };

  const scheduleExecution = (message: ScheduledMessage, delayMs: number) => {
    if (closed) {
      cleanupMessage(message);
      return;
    }

    if (message.timer) {
      clearTimeout(message.timer);
      message.timer = undefined;
    }

    const version = ++message.version;
    const enqueueRun = () => {
      message.pendingExecution = true;
      if (!message.running) {
        void executeMessage(message);
      }
    };

    if (delayMs <= 0) {
      enqueueRun();
      return;
    }

    const timeoutMs = Math.min(delayMs, MAX_SET_TIMEOUT_DELAY_MS);
    message.timer = globalThis.setTimeout(() => {
      if (message.version !== version || closed) {
        return;
      }
      message.timer = undefined;
      if (delayMs > MAX_SET_TIMEOUT_DELAY_MS) {
        scheduleExecution(message, delayMs - MAX_SET_TIMEOUT_DELAY_MS);
        return;
      }
      enqueueRun();
    }, timeoutMs);
  };

  const deliverMessage = async (
    message: ScheduledMessage
  ): Promise<
    | { kind: 'success' }
    | { kind: 'timeout'; delayMs: number }
    | { kind: 'server_error'; status: number; text: string }
  > => {
    const { pathname, prefix } = getQueueRoute(message.queueName);
    const headers: Record<string, string> = {
      ...message.headers,
      'content-type': 'application/json',
      'x-vqs-queue-name': message.queueName,
      'x-vqs-message-id': message.messageId,
      'x-vqs-message-attempt': String(message.attempt + 1),
    };
    const directHandler = directHandlers.get(prefix);
    let response: Response;

    if (directHandler) {
      const req = new Request(
        `http://localhost/.well-known/workflow/v1/${pathname}`,
        {
          method: 'POST',
          headers,
          body: message.body,
        }
      );
      response = await directHandler(req);
    } else {
      const baseUrl = await resolveBaseUrl(config);
      response = await fetch(`${baseUrl}/.well-known/workflow/v1/${pathname}`, {
        method: 'POST',
        duplex: 'half',
        dispatcher: httpAgent,
        headers,
        body: message.body,
      } as any);
    }

    const text = await response.text();

    if (response.ok) {
      try {
        const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
        if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
          return {
            kind: 'timeout',
            delayMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0,
          };
        }
      } catch {}

      return { kind: 'success' };
    }

    return {
      kind: 'server_error',
      status: response.status,
      text,
    };
  };

  const executeMessage = async (message: ScheduledMessage): Promise<void> => {
    if (closed || message.running) {
      return;
    }

    message.running = true;

    try {
      while (message.pendingExecution && !closed) {
        message.pendingExecution = false;
        const version = message.version;
        const token = semaphore.tryAcquire();
        if (!token) {
          console.warn(
            `[world-local]: concurrency limit (${WORKFLOW_LOCAL_QUEUE_CONCURRENCY}) reached, waiting for queue to free up`
          );
          await semaphore.acquire();
        }

        try {
          if (closed) {
            cleanupMessage(message);
            return;
          }

          if (version !== message.version) {
            continue;
          }

          const result = await deliverMessage(message);

          if (result.kind === 'success') {
            cleanupMessage(message);
            return;
          }

          if (result.kind === 'timeout') {
            message.attempt += 1;
            scheduleExecution(
              message,
              result.delayMs === 0
                ? 0
                : Math.min(result.delayMs, LOCAL_QUEUE_MAX_VISIBILITY * 1000)
            );
            continue;
          }

          console.error(
            `[world-local] Queue message failed (attempt ${
              message.attempt + 1
            }/3, status ${result.status}): ${result.text}`,
            { queueName: message.queueName, messageId: message.messageId }
          );

          message.attempt += 1;
          message.remainingServerRetries -= 1;
          if (message.remainingServerRetries > 0) {
            scheduleExecution(message, 0);
            continue;
          }

          console.error(`[world-local] Queue message exhausted all retries`, {
            queueName: message.queueName,
            messageId: message.messageId,
          });
          cleanupMessage(message);
          return;
        } finally {
          semaphore.release();
        }
      }
    } catch (err) {
      const queueError = err as { name?: string };
      const isAbortError =
        queueError.name === 'AbortError' ||
        queueError.name === 'ResponseAborted';
      if (!isAbortError) {
        console.error('[local world] Queue operation failed:', err);
      }
      cleanupMessage(message);
    } finally {
      message.running = false;
      if (message.pendingExecution && !closed) {
        void executeMessage(message);
      }
    }
  };

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const body = transport.serialize(message);
    const delayMs =
      typeof opts?.delaySeconds === 'number' && opts.delaySeconds > 0
        ? opts.delaySeconds * 1000
        : 0;

    if (opts?.idempotencyKey) {
      const existing = scheduledMessages.get(opts.idempotencyKey);
      if (existing) {
        if (existing.running) {
          return { messageId: existing.messageId };
        }

        existing.queueName = queueName;
        existing.body = body;
        existing.headers = opts.headers;
        scheduleExecution(existing, delayMs);
        return { messageId: existing.messageId };
      }
    }

    const scheduledMessage: ScheduledMessage = {
      attempt: 0,
      body,
      headers: opts?.headers,
      idempotencyKey: opts?.idempotencyKey,
      messageId: MessageId.parse(`msg_${generateId()}`),
      pendingExecution: false,
      queueName,
      remainingServerRetries: 3,
      running: false,
      version: 0,
    };

    if (opts?.idempotencyKey) {
      scheduledMessages.set(opts.idempotencyKey, scheduledMessage);
    }

    scheduleExecution(scheduledMessage, delayMs);
    return { messageId: scheduledMessage.messageId };
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

        if (timeoutSeconds != null) {
          return Response.json({ timeoutSeconds });
        }

        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      }
    };
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    const packageInfo = await getPackageInfo();
    return `dpl_local@${packageInfo.version}`;
  };

  return {
    queue,
    createQueueHandler,
    getDeploymentId,
    registerHandler(
      prefix: '__wkf_step_' | '__wkf_workflow_',
      handler: DirectHandler
    ) {
      directHandlers.set(prefix, handler);
    },
    async close() {
      closed = true;
      for (const message of scheduledMessages.values()) {
        cleanupMessage(message);
      }
      scheduledMessages.clear();
      await httpAgent.close();
    },
  };
}
