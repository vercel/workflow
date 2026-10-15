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
 *
 * A run's orchestrator deliveries (see `orchestratorRunIdOf`) go one at a
 * time, as on a per-run topic consumed with `maxConcurrency: 1`: a delivery
 * holds its run's lease from the moment it is handed to the handler until the
 * handler responds, and no other orchestrator message of that run is handed
 * out meanwhile. Step messages are never gated. The one way past the gate is
 * `expireLeases`, which models a delivery that outlived its lease: the queue
 * treats the run as free while that delivery keeps running.
 */

import {
  MessageId,
  orchestratorRunIdOf,
  parseQueueName,
  type Queue,
  type QueueOptions,
  type QueuePayload,
  type QueuePrefix,
  ValidQueueName,
} from '@workflow/world';
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

/** One orchestrator delivery holding its run's lease. */
export interface DeliveryLease {
  runId: string;
  messageId: string;
  /** The message being delivered. */
  message: QueuedMessage;
  /** Set by `expireLeases`: the delivery runs on, but no longer holds the run. */
  expired: boolean;
}

export interface SimQueue extends Queue {
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  handlerFor(queueName: string): DirectHandler | undefined;
  /** Pending messages in delivery order. */
  pending(): QueuedMessage[];
  /**
   * Remove and return the next message that may be delivered now, or
   * undefined when there is none. An orchestrator message whose run holds a
   * live lease is skipped, not returned.
   */
  takeNext(): QueuedMessage | undefined;
  /** Whether `message` may be delivered now (see `takeNext`). */
  isDeliverable(message: QueuedMessage): boolean;
  /**
   * Take the run's lease for an orchestrator delivery, waiting for the
   * current holder first. Resolves `undefined` at once for a message that is
   * not an orchestrator delivery. `onWait` is called once if it has to wait.
   */
  acquireLease(
    message: QueuedMessage,
    onWait?: (holder: DeliveryLease) => void
  ): Promise<DeliveryLease | undefined>;
  /** Give a lease back when its delivery has responded. */
  releaseLease(lease: DeliveryLease | undefined): void;
  /**
   * Expire the live lease of `runId`, as if its delivery had stalled past its
   * visibility timeout: it keeps running, and the run's next orchestrator
   * message can be delivered alongside it. With `redeliver`, the expired
   * message is also pending again (same `messageId`, the next delivery
   * count), which is what a queue does with a message whose lease lapsed.
   * Returns the leases it expired.
   */
  expireLeases(
    runId: string,
    options?: { redeliver?: boolean }
  ): DeliveryLease[];
  /**
   * Resolves the next time the set of deliverable messages may have grown:
   * a lease is released or expired, or a message is enqueued.
   */
  nextChange(): Promise<void>;
  /** Pending messages that only a live lease is holding back. */
  gated(): QueuedMessage[];
  /** Take a specific pending message, for scenario-chosen delivery order. */
  takeById(messageId: string): QueuedMessage | undefined;
  /** Put a message back for a later delivery attempt, preserving its messageId. */
  requeue(message: QueuedMessage, readyAtMs: number): void;
  /** Mark a message finished so its idempotency key can be reused. */
  settle(message: QueuedMessage): void;
  view(): PendingMessageView[];
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __type: 'Uint8Array',
      data: Buffer.from(value).toString('base64'),
    };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { __type?: string }).__type === 'Uint8Array' &&
    typeof (value as { data?: unknown }).data === 'string'
  ) {
    return new Uint8Array(
      Buffer.from((value as { data: string }).data, 'base64')
    );
  }
  return value;
}

export function encodeMessage(payload: QueuePayload): string {
  return JSON.stringify(payload, replacer);
}

export function decodeMessage(body: string): unknown {
  return JSON.parse(body, reviver);
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

  /** Live (unexpired) leases by run. At most one per run. */
  const leases = new Map<string, DeliveryLease>();
  let changeWaiters: (() => void)[] = [];
  const notifyChange = () => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const wake of waiters) wake();
  };
  const nextChange = () =>
    new Promise<void>((resolve) => {
      changeWaiters.push(resolve);
    });
  const isDeliverable = (message: QueuedMessage) => {
    const runId = orchestratorRunIdOf(message.payload);
    return runId === undefined || !leases.has(runId);
  };

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
    notifyChange();
    return { messageId: MessageId.parse(messageId) };
  };

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    return async (req: Request) => {
      const queueName = req.headers.get('x-vqs-queue-name');
      const messageId = req.headers.get('x-vqs-message-id');
      const attempt = Number(req.headers.get('x-vqs-message-attempt'));
      if (!queueName || !messageId || !Number.isFinite(attempt)) {
        return Response.json(
          { error: 'Missing required headers' },
          { status: 400 }
        );
      }
      if (!queueName.startsWith(prefix)) {
        return Response.json({ error: 'Unhandled queue' }, { status: 400 });
      }
      const body = decodeMessage(await req.text());
      try {
        const result = await handler(body, {
          attempt,
          queueName: ValidQueueName.parse(queueName),
          messageId: MessageId.parse(messageId),
        });
        if (
          typeof body === 'object' &&
          body !== null &&
          'invoke' in body &&
          body.invoke === true
        ) {
          return Response.json({ result });
        }
        if (
          typeof result === 'object' &&
          result !== null &&
          'timeoutSeconds' in result &&
          typeof result.timeoutSeconds === 'number'
        ) {
          return Response.json({ timeoutSeconds: result.timeoutSeconds });
        }
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      }
    };
  };

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
      const next = orderPending().find(isDeliverable);
      if (!next) return undefined;
      messages.splice(messages.indexOf(next), 1);
      return next;
    },
    isDeliverable,
    async acquireLease(message, onWait) {
      const runId = orchestratorRunIdOf(message.payload);
      if (runId === undefined) return undefined;
      let waited = false;
      for (let holder = leases.get(runId); holder; holder = leases.get(runId)) {
        if (!waited) {
          waited = true;
          onWait?.(holder);
        }
        await nextChange();
      }
      const lease: DeliveryLease = {
        runId,
        messageId: message.messageId,
        message,
        expired: false,
      };
      leases.set(runId, lease);
      return lease;
    },
    releaseLease(lease) {
      if (!lease || lease.expired) return;
      if (leases.get(lease.runId) === lease) leases.delete(lease.runId);
      notifyChange();
    },
    expireLeases(runId, options) {
      const lease = leases.get(runId);
      if (!lease) return [];
      lease.expired = true;
      leases.delete(runId);
      if (options?.redeliver) {
        messages.push({ ...lease.message, readyAtMs: opts.now(), seq: seq++ });
      }
      notifyChange();
      return [lease];
    },
    nextChange,
    gated() {
      return orderPending().filter((m) => !isDeliverable(m));
    },
    takeById(messageId) {
      const index = messages.findIndex((m) => m.messageId === messageId);
      if (index === -1) return undefined;
      return messages.splice(index, 1)[0];
    },
    requeue(message, readyAtMs) {
      messages.push({ ...message, readyAtMs, seq: seq++ });
      notifyChange();
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
