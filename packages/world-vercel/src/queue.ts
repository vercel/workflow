import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transport } from '@vercel/queue';
import { DuplicateMessageError, QueueClient } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  type QueueOptions,
  type QueuePayload,
  QueuePayloadSchema,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  ValidQueueName,
} from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { z } from 'zod/v4';
import { getDispatcher } from './http-client.js';
import { type APIConfig, getHeaders, getHttpUrl } from './utils.js';

/**
 * CBOR-based queue transport. Encodes values with cbor-x on send and
 * decodes on receive, preserving Uint8Array values natively (workflow
 * input is a Uint8Array in specVersion >= 2).
 *
 * Used for specVersion >= SPEC_VERSION_CURRENT (3).
 */
class CborTransport implements Transport<unknown> {
  readonly contentType = 'application/cbor';

  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value));
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return decode(Buffer.concat(chunks));
  }
}

/**
 * JSON-based queue transport. Used for specVersion < SPEC_VERSION_CURRENT
 * to maintain compatibility with older deployments that expect JSON messages.
 */
class JsonTransport implements Transport<unknown> {
  readonly contentType = 'application/json';

  serialize(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value));
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
}

/**
 * Dual transport for the queue handler. Serializes with CBOR (handler
 * re-enqueues target the same new deployment) but deserializes with
 * CBOR-first, falling back to JSON for messages from older deployments.
 */
class DualTransport implements Transport<unknown> {
  readonly contentType = 'application/cbor';

  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value));
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    try {
      return decode(buffer);
    } catch {
      return JSON.parse(buffer.toString());
    }
  }
}

const requestIdStorage = new AsyncLocalStorage<string | undefined>();

const MessageWrapper = z.object({
  payload: QueuePayloadSchema,
  queueName: ValidQueueName,
  /**
   * The deployment ID to use when re-enqueueing the message.
   * This ensures the message is processed by the same deployment.
   */
  deploymentId: z.string().optional(),
});

/**
 * Sleep Implementation via Message Delays
 *
 * VQS v3 supports `delaySeconds` which delays the initial delivery of a message.
 * We use this for implementing sleep() by creating a new message with the delay,
 * rather than using visibility timeouts on the same message.
 *
 * Benefits of this approach:
 * - Fresh 24-hour lifetime with each message (no message age tracking needed)
 * - Messages fire at the scheduled time (no short-circuit + recheck pattern)
 * - Simpler conceptual model: messages are triggers with delivery schedules
 *
 * For sleeps > 24 hours (max delay), we use chaining:
 * 1. Schedule message with max delay (~23h, leaving buffer)
 * 2. When it fires, workflow checks if sleep is complete
 * 3. If not, another delayed message is queued for remaining time
 * 4. Process repeats until the full sleep duration has elapsed
 *
 * The workflow runtime handles this via event sourcing - the `wait_created` event
 * stores the `resumeAt` timestamp, and on each invocation the runtime checks
 * if `now >= resumeAt`. If not, it returns another `timeoutSeconds`.
 *
 * These constants can be overridden via environment variables for testing.
 */
const MAX_DELAY_SECONDS = Number(
  process.env.VERCEL_QUEUE_MAX_DELAY_SECONDS || 82800 // 23 hours - leave 1h buffer before 24h retention limit
);

/**
 * Extract known identifiers from a queue payload and return them as VQS headers.
 * This ensures observability headers are always set without relying on callers.
 */
function getHeadersFromPayload(
  payload: QueuePayload
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if ('runId' in payload && typeof payload.runId === 'string') {
    headers['x-vercel-workflow-run-id'] = payload.runId;
  }
  if ('workflowRunId' in payload && typeof payload.workflowRunId === 'string') {
    headers['x-vercel-workflow-run-id'] = payload.workflowRunId;
  }
  if ('stepId' in payload && typeof payload.stepId === 'string') {
    headers['x-vercel-workflow-step-id'] = payload.stepId;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

type QueueFunction = (
  queueName: ValidQueueName,
  payload: QueuePayload,
  opts?: QueueOptions
) => ReturnType<Queue['queue']>;

export function createQueue(config?: APIConfig): Queue {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config, { usingProxy });

  const region = 'iad1';

  const cborTransport = new CborTransport();
  const jsonTransport = new JsonTransport();
  const dualTransport = new DualTransport();

  const clientOptions = {
    region,
    dispatcher: getDispatcher(),
    transport: dualTransport,
    ...(usingProxy && {
      // final path will be /queues-proxy/api/v3/topic/...
      // and the proxy will strip the /queues-proxy prefix before forwarding to VQS
      resolveBaseUrl: () => new URL(`${baseUrl}/queues-proxy`),
      token: config?.token,
    }),
    headers: Object.fromEntries(headers.entries()),
  };

  const queue: QueueFunction = async (
    queueName,
    payload,
    opts?: QueueOptions
  ) => {
    // Check if we have a deployment ID either from options or environment
    const deploymentId = opts?.deploymentId ?? process.env.VERCEL_DEPLOYMENT_ID;
    if (!deploymentId) {
      throw new Error(
        'No deploymentId provided and VERCEL_DEPLOYMENT_ID environment variable is not set. ' +
          'Queue messages require a deployment ID to route correctly. ' +
          'Either set VERCEL_DEPLOYMENT_ID or provide deploymentId in options.'
      );
    }

    // Select transport based on the target run's specVersion:
    // CBOR for specVersion >= 3 (CBOR transport), JSON for older ones.
    const useCbor =
      (opts?.specVersion ?? SPEC_VERSION_CURRENT) >=
      SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT;
    const transport = useCbor ? cborTransport : jsonTransport;

    const client = new QueueClient({
      ...clientOptions,
      deploymentId,
      transport,
    });

    // The CborTransport handles CBOR encoding inside serialize(),
    // preserving Uint8Array values (workflow input in specVersion >= 2).
    const wrapper = {
      payload,
      queueName,
      // Store deploymentId in the message so it can be preserved when re-enqueueing
      deploymentId: opts?.deploymentId,
    };
    const sanitizedQueueName = queueName.replace(/[^A-Za-z0-9-_]/g, '-');
    try {
      const { messageId } = await client.send(sanitizedQueueName, wrapper, {
        idempotencyKey: opts?.idempotencyKey,
        delaySeconds: opts?.delaySeconds,
        headers: {
          ...getHeadersFromPayload(payload),
          ...opts?.headers,
        },
      });
      return {
        // messageId may be null when VQS fails over to a different region —
        // the event is ingested but the responding region cannot return an ID.
        messageId: messageId ? MessageId.parse(messageId) : null,
      };
    } catch (error) {
      // Silently handle idempotency key conflicts - the message was already queued.
      // This matches the behavior of world-local and world-postgres.
      if (error instanceof DuplicateMessageError) {
        // Return a placeholder messageId since the original is not available from the error.
        // Callers using idempotency keys shouldn't depend on the returned messageId.
        return {
          messageId: MessageId.parse(
            `msg_duplicate_${error.idempotencyKey ?? opts?.idempotencyKey ?? 'unknown'}`
          ),
        };
      }
      throw error;
    }
  };

  const createQueueHandler: Queue['createQueueHandler'] = (
    _prefix,
    handler
  ) => {
    const client = new QueueClient(clientOptions);
    const vqsHandler = client.handleCallback(
      async (message: unknown, metadata) => {
        if (!message || !metadata) {
          return;
        }

        const requestId = requestIdStorage.getStore();
        // The CborTransport handles CBOR decoding inside deserialize(),
        // so message is already a plain object with Uint8Array values intact.
        const { payload, queueName, deploymentId } =
          MessageWrapper.parse(message);

        const result = await handler(payload, {
          queueName,
          messageId: MessageId.parse(metadata.messageId),
          attempt: metadata.deliveryCount,
          requestId,
        });

        if (typeof result?.timeoutSeconds === 'number') {
          // When timeoutSeconds is 0, skip delaySeconds entirely for immediate re-enqueue.
          // Otherwise, clamp to max delay (23h) - for longer sleeps, the workflow will chain
          // multiple delayed messages until the full sleep duration has elapsed.
          const delaySeconds =
            result.timeoutSeconds > 0
              ? Math.min(result.timeoutSeconds, MAX_DELAY_SECONDS)
              : undefined;

          // Send new message BEFORE acknowledging current message.
          // This ensures crash safety: if process dies after send but before ack,
          // we may get a duplicate invocation but won't lose the scheduled wakeup.
          await queue(queueName, payload, { deploymentId, delaySeconds });
        }
      }
    );

    return async (req: Request) => {
      const rawId = req.headers.get('x-vercel-id');
      const requestId = rawId?.trim() || undefined;
      return requestIdStorage.run(requestId, () => vqsHandler(req));
    };
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (!deploymentId) {
      throw new Error('VERCEL_DEPLOYMENT_ID environment variable is not set');
    }
    return deploymentId;
  };

  return { queue, createQueueHandler, getDeploymentId };
}
