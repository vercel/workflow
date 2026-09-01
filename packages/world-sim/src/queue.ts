/**
 * Deterministic queue.
 *
 * `@workflow/world-local`'s queue fires a detached async delivery loop from
 * inside `queue()`, so the moment a message is enqueued it is racing whatever
 * the caller does next. That is faithful to production and useless for a
 * simulation: the interleaving is picked by the event loop, not by the test.
 *
 * Here `queue()` only *records* a message. Nothing is ever delivered until the
 * scheduler asks for the next one, and the scheduler always takes the same one:
 * the minimum by `(readyAtMs, enqueueSeq)`. Delays are virtual (a message
 * scheduled 23 hours out is delivered by jumping the clock, not by waiting),
 * which is what lets a scenario containing `sleep('30d')` finish in
 * microseconds.
 */

import {
  MessageId,
  parseQueueName,
  type Queue,
  type QueueOptions,
  type QueuePayload,
  type QueuePrefix,
  ValidQueueName,
} from '@workflow/world';
import { createFetchQueueHandler } from '@workflow/world/queue-http.js';
import {
  deserializeQueueMessage,
  serializeQueueMessage,
} from '@workflow/world/queue-json.js';
import type { IdFactory } from './ids.js';
import type { PendingMessageView } from './types.js';

export interface QueuedMessage {
  messageId: string;
  queueName: ValidQueueName;
  payload: QueuePayload;
  readyAtMs: number;
  /** Enqueue order; the tiebreak that makes delivery order total. */
  seq: number;
  /** Delivery attempts already handed to a handler (the `attempt` header is this + 1). */
  deliveries: number;
  idempotencyKey?: string;
}

export type DirectHandler = (req: Request) => Promise<Response>;

export interface SimQueue extends Queue {
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  handlerFor(queueName: string): DirectHandler | undefined;
  /** Pending messages in delivery order. */
  pending(): QueuedMessage[];
  /** Remove and return the next message to deliver, or undefined when idle. */
  takeNext(): QueuedMessage | undefined;
  /** Take a specific pending message, for scenario-chosen delivery order. */
  takeById(messageId: string): QueuedMessage | undefined;
  /** Put a message back for a later delivery attempt, preserving its messageId. */
  requeue(message: QueuedMessage, readyAtMs: number): void;
  /** Mark a message finished so its idempotency key can be reused. */
  settle(message: QueuedMessage): void;
  view(): PendingMessageView[];
}

export function encodeMessage(payload: QueuePayload): string {
  return serializeQueueMessage(payload).toString();
}

export function decodeMessage(body: string): unknown {
  return deserializeQueueMessage(Buffer.from(body));
}

export function createSimQueue(opts: {
  now(): number;
  ids: IdFactory;
  deploymentId: string;
}): SimQueue {
  const messages: QueuedMessage[] = [];
  const handlers = new Map<string, DirectHandler>();
  /**
   * Idempotency keys of messages that are enqueued but not yet settled. This
   * matches world-local's in-flight-only dedupe window (VQS holds keys for
   * longer); the wait-continuation logic in core is written against exactly
   * this behavior, and widening the window here would silently drop the
   * re-enqueues it relies on.
   */
  const inflightKeys = new Map<string, string>();
  let seq = 0;

  const queue: Queue['queue'] = async (
    queueName: ValidQueueName,
    message: QueuePayload,
    options?: QueueOptions
  ) => {
    if (options?.idempotencyKey) {
      const existing = inflightKeys.get(options.idempotencyKey);
      if (existing) return { messageId: MessageId.parse(existing) };
    }

    // Round-trip through the wire encoding at enqueue time so a scenario can
    // never accidentally hand the handler a live object reference that
    // production would have serialized.
    const payload = decodeMessage(encodeMessage(message)) as QueuePayload;

    const messageId = opts.ids.messageId();
    const delayMs = Math.max(0, (options?.delaySeconds ?? 0) * 1000);
    const entry: QueuedMessage = {
      messageId,
      queueName,
      payload,
      readyAtMs: opts.now() + delayMs,
      seq: seq++,
      deliveries: 0,
      idempotencyKey: options?.idempotencyKey,
    };
    if (options?.idempotencyKey) {
      inflightKeys.set(options.idempotencyKey, messageId);
    }
    messages.push(entry);
    return { messageId: MessageId.parse(messageId) };
  };

  const createQueueHandler: Queue['createQueueHandler'] =
    createFetchQueueHandler;

  const orderPending = () =>
    [...messages].sort((a, b) =>
      a.readyAtMs !== b.readyAtMs ? a.readyAtMs - b.readyAtMs : a.seq - b.seq
    );

  return {
    queue,
    createQueueHandler,
    async getDeploymentId() {
      return opts.deploymentId;
    },
    registerHandler(prefix, handler) {
      handlers.set(prefix, handler);
    },
    handlerFor(queueName) {
      const { prefix } = parseQueueName(ValidQueueName.parse(queueName));
      return handlers.get(prefix);
    },
    pending: orderPending,
    takeNext() {
      const ordered = orderPending();
      const next = ordered[0];
      if (!next) return undefined;
      messages.splice(messages.indexOf(next), 1);
      return next;
    },
    takeById(messageId) {
      const index = messages.findIndex((m) => m.messageId === messageId);
      if (index === -1) return undefined;
      return messages.splice(index, 1)[0];
    },
    requeue(message, readyAtMs) {
      messages.push({ ...message, readyAtMs, seq: seq++ });
    },
    settle(message) {
      if (
        message.idempotencyKey &&
        inflightKeys.get(message.idempotencyKey) === message.messageId
      ) {
        inflightKeys.delete(message.idempotencyKey);
      }
    },
    view() {
      return orderPending().map((m) => {
        const payload = m.payload as { runId?: string; stepId?: string };
        return {
          messageId: m.messageId,
          queueName: m.queueName,
          runId: payload.runId,
          stepId: payload.stepId,
          readyAtMs: m.readyAtMs,
          deliveries: m.deliveries,
        };
      });
    },
  };
}
