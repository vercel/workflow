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
 * A single-orchestrator run's orchestrator deliveries (see
 * `singleOrchestratorRunIdOf`) go one at a time, as world-vercel's
 * concurrency key and world-local's and world-postgres's per-run gates keep
 * them: a delivery
 * holds its run's lease from the moment it is handed to the handler until the
 * handler responds, and no other orchestrator message of that run is handed
 * out meanwhile. Step messages are never gated, and neither is a message
 * that does not say it belongs to a spec 9 run: an unstamped wake, or any
 * message of an earlier run, runs beside the lease holder as it does on
 * world-vercel (world-local and world-postgres read an unstamped wake's spec
 * from its run and gate it). The one way past the gate is
 * `expireLeases`, which models a delivery that outlived its lease: the queue
 * treats the run as free while that delivery keeps running.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  isSingleOrchestratorMessage,
  MessageId,
  parseQueueName,
  type Queue,
  type QueueHandler,
  type QueueHoldResult,
  type QueueOptions,
  type QueuePayload,
  type QueuePrefix,
  singleOrchestratorRunIdOf,
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
  /**
   * Deliveries that ended in a handoff (`{ timeoutSeconds: 0 }` on a
   * single-orchestrator run), which `attempt` leaves out.
   */
  handoffs?: number;
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
  /**
   * Held messages (`QueueOptions.experimental_hold`) whose sender is running
   * them and whose hold has not lapsed. The delivery loop is not quiet while
   * one is in flight: it may still enqueue.
   */
  heldInFlight(): HeldDelivery[];
  /**
   * Let the hold of `runId`'s (or every) in-flight held message lapse, as a
   * queue does when the sender stops renewing it: the message is pending
   * again (same `messageId`, the next delivery count), and the sender's
   * delivery keeps running without the run's lease. With `crash`, the sender
   * died instead: no world call its delivery makes from now on takes effect,
   * and none in flight answers (see `SimulatedCrashError`). Returns the holds
   * it lapsed.
   */
  lapseHolds(options?: { runId?: string; crash?: boolean }): HeldDelivery[];
}

/** One message a sender holds and runs itself (`experimental_hold`). */
export interface HeldDelivery {
  message: QueuedMessage;
  /** The run's orchestrator lease, for a single-orchestrator message. */
  lease: DeliveryLease | undefined;
  /** Set once the hold lapsed: the queue has the message back. */
  lapsed: boolean;
  /** Set when the sender "died": its world calls fail without effect. */
  crashed: boolean;
  /** Set once `consume` returned. */
  finished: boolean;
}

/**
 * The held delivery the current call chain belongs to, if any: set around
 * `consume`'s handler, so the world can tell a dead sender's calls apart.
 */
export const heldDeliveryContext = new AsyncLocalStorage<HeldDelivery>();

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
  /** Messages held by their sender, by message id. */
  const holds = new Map<string, HeldDelivery>();
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
    const runId = singleOrchestratorRunIdOf(message.payload);
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
    if (options?.experimental_hold) {
      if (options.delaySeconds !== undefined) {
        throw new TypeError(
          'experimental_hold cannot be combined with delaySeconds'
        );
      }
      return {
        messageId: MessageId.parse(messageId),
        experimental_hold: hold(entry),
      };
    }
    messages.push(entry);
    notifyChange();
    return { messageId: MessageId.parse(messageId) };
  };

  /**
   * Claims `entry` for its sender, as Vercel Queues' send-and-hold does: its
   * first delivery is the sender's to run. A single-orchestrator message
   * whose run already has an orchestrator delivery in flight is not held
   * (`lost`, the run's concurrency key is taken) and is delivered as usual.
   */
  const hold = (entry: QueuedMessage): QueueHoldResult => {
    const runId = singleOrchestratorRunIdOf(entry.payload);
    if (runId !== undefined && leases.has(runId)) {
      messages.push(entry);
      notifyChange();
      return { status: 'not_held', reason: 'lost' };
    }
    const lease: DeliveryLease | undefined =
      runId === undefined
        ? undefined
        : { runId, messageId: entry.messageId, message: entry, expired: false };
    if (lease) leases.set(lease.runId, lease);
    const delivery: HeldDelivery = {
      message: entry,
      lease,
      lapsed: false,
      crashed: false,
      finished: false,
    };
    holds.set(entry.messageId, delivery);
    let used = false;
    const done = () => {
      delivery.finished = true;
      holds.delete(entry.messageId);
      if (lease && !lease.expired && leases.get(lease.runId) === lease) {
        leases.delete(lease.runId);
      }
      notifyChange();
    };
    return {
      status: 'held',
      messageId: MessageId.parse(entry.messageId),
      leaseExpiresAt: new Date(opts.now() + 30_000),
      async consume(handler: QueueHandler) {
        if (used) throw new Error('consume() called twice');
        used = true;
        entry.deliveries++;
        try {
          let result: unknown;
          let failed = false;
          try {
            result = await heldDeliveryContext.run(delivery, () =>
              handler(entry.payload, {
                attempt: 1,
                deliveryCount: 1,
                queueName: entry.queueName,
                messageId: MessageId.parse(entry.messageId),
              })
            );
          } catch {
            failed = true;
          }
          // A lapsed hold is the queue's again: what this delivery answers
          // no longer decides anything.
          if (delivery.lapsed) return;
          if (failed) {
            requeueEntry(entry, opts.now() + 5_000);
            return;
          }
          if (
            typeof result === 'object' &&
            result !== null &&
            'timeoutSeconds' in result &&
            typeof result.timeoutSeconds === 'number'
          ) {
            if (
              result.timeoutSeconds === 0 &&
              isSingleOrchestratorMessage(entry.payload)
            ) {
              entry.handoffs = (entry.handoffs ?? 0) + 1;
            }
            requeueEntry(entry, opts.now() + result.timeoutSeconds * 1000);
            return;
          }
          settleEntry(entry);
        } finally {
          done();
        }
      },
      async release(delaySeconds?: number) {
        if (used) throw new Error('release() after consume()');
        used = true;
        done();
        requeueEntry(entry, opts.now() + (delaySeconds ?? 0) * 1000);
      },
    };
  };

  const requeueEntry = (message: QueuedMessage, readyAtMs: number) => {
    messages.push({ ...message, readyAtMs, seq: seq++ });
    notifyChange();
  };
  const settleEntry = (message: QueuedMessage) => {
    if (
      message.idempotencyKey &&
      inflightKeys.get(message.idempotencyKey) === message.messageId
    ) {
      inflightKeys.delete(message.idempotencyKey);
    }
  };

  const lapse = (delivery: HeldDelivery, crash: boolean) => {
    delivery.lapsed = true;
    delivery.crashed ||= crash;
    holds.delete(delivery.message.messageId);
    const { lease } = delivery;
    if (lease && !lease.expired) {
      lease.expired = true;
      if (leases.get(lease.runId) === lease) leases.delete(lease.runId);
    }
    requeueEntry(delivery.message, opts.now());
  };

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    return async (req: Request) => {
      const queueName = req.headers.get('x-vqs-queue-name');
      const messageId = req.headers.get('x-vqs-message-id');
      const attempt = Number(req.headers.get('x-vqs-message-attempt'));
      const deliveryCount = Number(
        req.headers.get('x-vqs-message-delivery-count') ?? attempt
      );
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
          ...(Number.isFinite(deliveryCount) ? { deliveryCount } : {}),
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
    // `drive.ts` delivers every message with this process's key.
    queueAuthMode: 'loopback',
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
      const runId = singleOrchestratorRunIdOf(message.payload);
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
      const held = holds.get(lease.messageId);
      if (held?.lease === lease) {
        // A held message's lease: its hold lapses, which always hands the
        // message back to the queue.
        lapse(held, false);
        return [lease];
      }
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
    requeue: requeueEntry,
    settle: settleEntry,
    heldInFlight() {
      return [...holds.values()].filter((h) => !h.lapsed && !h.finished);
    },
    lapseHolds(options) {
      const lapsed: HeldDelivery[] = [];
      for (const delivery of [...holds.values()]) {
        if (delivery.lapsed || delivery.finished) continue;
        if (options?.runId && delivery.lease?.runId !== options.runId) {
          const payload = delivery.message.payload as { runId?: string };
          if (payload.runId !== options.runId) continue;
        }
        lapse(delivery, options?.crash === true);
        lapsed.push(delivery);
      }
      return lapsed;
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
