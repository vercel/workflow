import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { AWSWorldConfig } from './config.js';

function parseQueueName(queueName: ValidQueueName): [QueuePrefix, string] {
  // Queue names are like: __wkf_workflow_someId or __wkf_step_someId
  if (queueName.startsWith('__wkf_workflow_')) {
    return ['__wkf_workflow_', queueName.slice('__wkf_workflow_'.length)];
  } else if (queueName.startsWith('__wkf_step_')) {
    return ['__wkf_step_', queueName.slice('__wkf_step_'.length)];
  }
  throw new Error(`Invalid queue name format: ${queueName}`);
}

export function createQueue(client: SQSClient, config: AWSWorldConfig): Queue {
  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const Queues = {
    __wkf_workflow_: config.queues.workflow,
    __wkf_step_: config.queues.step,
  } as const satisfies Record<QueuePrefix, string>;

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'aws';
  };

  const createQueueHandler: Queue['createQueueHandler'] = (
    _prefix,
    handler
  ) => {
    // Return a handler that directly invokes the user's handler
    // This follows the same pattern as @workflow/world-vercel
    return async (request) => {
      try {
        // Parse the message from the request body
        const message = await request.json();

        // Parse metadata from headers (matching Vercel Queue format)
        const queueName = request.headers.get(
          'x-vqs-queue-name'
        ) as ValidQueueName;
        const messageId = request.headers.get('x-vqs-message-id') || 'unknown';
        const attempt = Number(
          request.headers.get('x-vqs-message-attempt') || '1'
        );

        // Invoke the user's handler directly (no HTTP, no embedded world)
        const result = await handler(message, {
          queueName,
          messageId: MessageId.parse(messageId),
          attempt,
        });

        if (result && typeof result === 'object') {
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        console.error('Queue handler error:', error);
        return new Response(JSON.stringify({ error: String(error) }), {
          status: 500,
        });
      }
    };
  };

  const queue: Queue['queue'] = async (queue, message, opts) => {
    const [prefix, queueId] = parseQueueName(queue);
    const queueUrl = Queues[prefix];

    if (!queueUrl) {
      throw new Error(
        `Queue URL not found for prefix: ${prefix}. Available: ${Object.keys(
          Queues
        ).join(', ')}`
      );
    }

    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    // Convert Buffer to base64 to avoid JSON serialization issues
    const dataBase64 = body.toString('base64');

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          id: queueId,
          data: dataBase64,
          attempt: 1,
          messageId,
          idempotencyKey: opts?.idempotencyKey,
        }),
        // FIFO parameters only if queue URL ends with .fifo
        ...(queueUrl?.endsWith('.fifo')
          ? {
              MessageDeduplicationId: opts?.idempotencyKey ?? messageId,
              MessageGroupId: queueId,
            }
          : {}),
      })
    );

    return { messageId };
  };

  return {
    getDeploymentId,
    queue,
    createQueueHandler,
  };
}
