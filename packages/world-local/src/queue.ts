/**
 * world-local's queue: messages are rows of the data directory's database
 * (`messages`), delivered by a consumer loop in every process that uses the
 * World to enqueue (or that called `start()`).
 *
 * - **Durable.** A message survives a restart: delayed deliveries, wait
 *   timers and retry backoffs resume where they were, and a delivery whose
 *   process died is redelivered once its lease lapses.
 * - **Leased.** A consumer claims a message with a lease it keeps renewing
 *   while the delivery runs, in one transaction, so a message is delivered
 *   by one consumer at a time across every process on the data directory.
 * - **One orchestrator delivery per run.** A single-orchestrator run's
 *   (spec >= 9) orchestrator messages share a lane; a message is not claimed
 *   while another message of its lane is leased. With the in-band fence, the
 *   two halves of the single-writer guarantee. Step messages, health checks
 *   and earlier runs' messages have no lane.
 * - **Delivered where they can be.** A consumer claims a message only when
 *   it can deliver it: through an in-process handler registered for its
 *   prefix, or over HTTP when it can resolve the app's URL. A script or test
 *   process that calls `start()` against a running dev server, and cannot
 *   reach it, only enqueues: the server's consumer delivers.
 *
 * The delivery itself (headers, HTTP transport, retry and backoff rules,
 * `{ timeoutSeconds }` redeliveries, handoffs) is unchanged from the
 * in-memory queue this replaced.
 */

import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Transport } from '@vercel/queue';
import {
  createAppRouteUrl,
  createWorkflowUrl,
  globalSingleton,
} from '@workflow/utils';
import {
  isNodeHttpEnabled,
  isSingleOrchestratorMessage,
  MessageId,
  parseQueueName,
  parseQueueRoute,
  type Queue,
  QueuePrefix,
  singleOrchestratorRunIdOf,
  ValidQueueName,
  WORKFLOW_FLOW_ROUTE,
} from '@workflow/world';
import {
  createNodeHttpAgents,
  destroyNodeHttpAgents,
  nodeHttpFetch,
} from '@workflow/world/node-http.js';
import { monotonicFactory } from 'ulid';
import { Agent } from 'undici';
import { z } from 'zod/v4';
import type { Config } from './config.js';
import {
  config as defaultConfig,
  resolveBaseUrl,
  resolveDirectBaseUrl,
} from './config.js';
import { jsonReplacer, jsonReviver } from './db/codec.js';
import { type Database, databaseFor } from './db/index.js';
import { getPackageInfo } from './init.js';
import { queueNow } from './queue-clock.js';

/**
 * JSON transport that preserves Uint8Array values:
 * Uint8Array → { __type: 'Uint8Array', data: '<base64>' } in JSON.
 */
class TypedJsonTransport implements Transport<unknown> {
  readonly contentType = 'application/json';

  serialize(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value, jsonReplacer));
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString(), jsonReviver);
  }
}

// No technical limit on a message's visibility lifespan, but the variable can
// set one for tests.
const LOCAL_QUEUE_MAX_VISIBILITY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_MAX_VISIBILITY ?? '0', 10) ||
  Infinity;

/** Longest delay a message is held for at once (≈ 24.8 days). */
const MAX_SAFE_TIMEOUT_MS = 2147483647;

/**
 * The most deliveries world-local makes of one message (handoffs aside): a
 * guard against a message that fails forever. The runtime enforces its own
 * delivery cap well below it.
 */
export const MAX_LOCAL_SAFETY_LIMIT = 256;

/** Handoffs counted as such per message; past it a handoff is an attempt. */
const MAX_LOCAL_HANDOFFS = 10_000;

/** Failed deliveries retried 5s apart, before the backoff grows. */
const LINEAR_RETRY_DELIVERIES = 32;
const LINEAR_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

/** Delay before retrying a delivery that failed at the transport. */
const TRANSPORT_RETRY_DELAY_MS = 5_000;

/**
 * The delay before world-local retries a message whose `failedDeliveries`-th
 * delivery failed: 5s for the first 32, as Vercel Queues does, then doubling
 * up to a minute.
 */
export function localRetryDelayMs(failedDeliveries: number): number {
  if (failedDeliveries <= LINEAR_RETRY_DELIVERIES) return LINEAR_RETRY_DELAY_MS;
  return Math.min(
    MAX_RETRY_DELAY_MS,
    LINEAR_RETRY_DELAY_MS * 2 ** (failedDeliveries - LINEAR_RETRY_DELIVERIES)
  );
}

// The local workers share the same Node.js process and event loop, so the
// number of deliveries in flight is bounded.
const DEFAULT_CONCURRENCY_LIMIT = 1000;

function queueConcurrency(): number {
  return (
    parseInt(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY ?? '0', 10) ||
    DEFAULT_CONCURRENCY_LIMIT
  );
}

/**
 * How long a claimed message stays leased without a renewal. A consumer
 * renews its leases every {@link LEASE_RENEW_MS} while their deliveries run,
 * so this only bounds how long a message whose process died waits before
 * another consumer redelivers it.
 */
const LEASE_MS = 30_000;
const LEASE_RENEW_MS = 5_000;

/** How often an idle consumer looks for messages another process enqueued. */
const POLL_INTERVAL_MS = 100;

/** How long a consumer that cannot reach the app waits before trying again. */
const BASE_URL_RETRY_MS = 1_000;

/**
 * Default time-to-first-byte deadline for local queue deliveries: none. A
 * delivery runs inline steps before it responds, so any client-side deadline
 * shorter than the longest step redelivers a live message and re-executes the
 * step while the original is still running (workflow#3909).
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 0;

/** Default maximum gap between response body chunks for local deliveries. */
export const DEFAULT_BODY_TIMEOUT_MS = 0;

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Deliveries are unbounded by default. Operators who would rather a hung
 * handler be redelivered can opt in to a deadline; a transport timeout is then
 * retried with the same durable message, so the deadline must exceed the
 * longest inline step.
 */
export function getQueueAgentOptions() {
  return {
    bodyTimeout: envTimeoutMs(
      'WORKFLOW_LOCAL_BODY_TIMEOUT_MS',
      DEFAULT_BODY_TIMEOUT_MS
    ),
    connections: 1000,
    headersTimeout: envTimeoutMs(
      'WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS',
      DEFAULT_HEADERS_TIMEOUT_MS
    ),
    keepAliveTimeout: 30_000,
  } as const;
}

export type DirectHandler = (req: Request) => Promise<Response>;

export type LocalQueue = Queue & {
  /** Stop delivering and release resources. */
  close(): Promise<void>;
  /** Register a direct in-process handler for a queue prefix, bypassing HTTP. */
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  /**
   * Route a queue prefix's HTTP deliveries to `path` on the app instead of
   * the Workflow SDK's flow route (see `Queue.registerRoute`).
   */
  registerRoute(prefix: QueuePrefix, path: string): void;
  /** Start delivering this data directory's messages from this process. */
  startConsumer(): void;
  /** Runs that have a message in the queue (any state). */
  runsWithMessages(runIds: readonly string[]): Set<string>;
};

const DETACHED_ARRAYBUFFER_ERROR =
  'Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer';
const PROXY_HANDLER_DOCS_URL =
  'https://workflow-sdk.dev/docs/getting-started/next#configure-proxy-handler';

function isDetachedArrayBufferQueueError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (
      'message' in current &&
      typeof current.message === 'string' &&
      current.message.includes(DETACHED_ARRAYBUFFER_ERROR)
    ) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Per-run mutual exclusion in FIFO order, held by `createQueueHandler`
 * around a single-orchestrator run's orchestrator deliveries. The queue's
 * lanes already deliver those one at a time; this also covers a handler
 * that receives messages from another sender (world-postgres reuses it).
 */
export function createRunGate() {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(runId: string): Promise<() => void> {
      const previous = tails.get(runId) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => held);
      tails.set(runId, tail);
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        if (tails.get(runId) === tail) tails.delete(runId);
      };
    },
    /** Runs with a delivery in flight or waiting. For tests. */
    size(): number {
      return tails.size;
    },
  };
}

interface MessageRow {
  id: string;
  queue_name: string;
  prefix: string;
  transport: string;
  body: string;
  headers: string | null;
  hands_off: number;
  run_id: string | null;
  step_id: string | null;
  deliveries: number;
  handoffs: number;
  failures: number;
  created_at: string;
}

/** This process, as named on the leases it holds. */
const processIdentity = globalSingleton(
  '@workflow/world-local//queueProcess',
  1,
  () => {
    let pidNamespace = '';
    try {
      pidNamespace = readlinkSync('/proc/self/ns/pid');
    } catch {}
    return { host: hostname(), pid: process.pid, pidNamespace };
  }
);

function leaseOwnerPrefix(): string {
  const { host, pid, pidNamespace } = processIdentity;
  return `${host}|${pidNamespace}|${pid}|`;
}

/**
 * Whether a lease names a process on this host (and in this pid namespace)
 * that is gone. Only ever used to redeliver sooner: a lease left by a dead
 * process also lapses on its own.
 */
function isLeaseOwnerDead(owner: string): boolean {
  const [host, pidNamespace, pidText] = owner.split('|');
  const {
    host: myHost,
    pid: myPid,
    pidNamespace: myNamespace,
  } = processIdentity;
  if (host !== myHost || pidNamespace !== myNamespace) return false;
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || pid === myPid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function createQueue(config: Partial<Config>): LocalQueue {
  const dataDir = config.dataDir ?? defaultConfig.value.dataDir;
  const tag = config.tag;
  let database: Database | undefined;
  const db = () => (database ??= databaseFor(dataDir));

  const agentOptions = getQueueAgentOptions();
  const nodeHttpAgents = isNodeHttpEnabled()
    ? createNodeHttpAgents({
        maxSockets: agentOptions.connections,
        keepAliveMs: agentOptions.keepAliveTimeout,
      })
    : undefined;
  const httpAgent = nodeHttpAgents ? undefined : new Agent(agentOptions);
  const transport = new TypedJsonTransport();
  const generateId = monotonicFactory();
  const concurrency = queueConcurrency();
  const handlerRunGate = createRunGate();

  const closeController = new AbortController();
  const closeSignal = closeController.signal;

  /** Direct in-process handlers by queue prefix, bypassing HTTP when set. */
  const directHandlers = new Map<string, DirectHandler>();
  /**
   * HTTP delivery routes by queue prefix. A prefix without one is delivered
   * to the Workflow SDK's flow route. Read on every delivery.
   */
  const routes = new Map<string, string>();
  const deliveryUrl = (baseUrl: string, prefix: string) => {
    const route = routes.get(prefix);
    return route
      ? createAppRouteUrl(baseUrl, route)
      : createWorkflowUrl(baseUrl, { type: 'flow' });
  };

  // ---------------------------------------------------------------- consumer

  const leaseOwner = `${leaseOwnerPrefix()}${generateId()}`;
  const inflight = new Map<string, AbortController>();
  let consumerStarted = false;
  let wake: (() => void) | null = null;
  let baseUrl: { value?: string; retryAt: number } = { retryAt: 0 };
  let lastDeadOwnerSweep = 0;

  const wakeConsumer = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  /** The app's URL, if this process can reach it, checked lazily. */
  async function httpBaseUrl(): Promise<string | undefined> {
    if (baseUrl.value) return baseUrl.value;
    if (queueNow() < baseUrl.retryAt) return undefined;
    try {
      baseUrl = { value: await resolveBaseUrl(config), retryAt: 0 };
    } catch {
      baseUrl = { retryAt: queueNow() + BASE_URL_RETRY_MS };
    }
    return baseUrl.value;
  }

  function releaseDeadOwnersLeases(now: number): void {
    if (now - lastDeadOwnerSweep < 2_000) return;
    lastDeadOwnerSweep = now;
    const leased = db().all<{ id: string; lease_owner: string }>(
      `SELECT id, lease_owner FROM messages
       WHERE lease_until >= ? AND lease_owner IS NOT NULL AND lease_owner <> ?`,
      now,
      leaseOwner
    );
    const owners = new Map<string, boolean>();
    for (const row of leased) {
      let dead = owners.get(row.lease_owner);
      if (dead === undefined) {
        dead = isLeaseOwnerDead(row.lease_owner);
        owners.set(row.lease_owner, dead);
      }
      if (dead) {
        db().run(
          'UPDATE messages SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?',
          row.id,
          row.lease_owner
        );
      }
    }
  }

  /** Claims up to `limit` deliverable messages, at most one per lane. */
  function claim(limit: number, canHttp: boolean): MessageRow[] {
    const now = queueNow();
    releaseDeadOwnersLeases(now);
    const prefixes = [...directHandlers.keys()];
    const deliverable = [
      ...(canHttp ? ["transport = 'http'"] : []),
      ...(prefixes.length
        ? [`prefix IN (${prefixes.map(() => '?').join(', ')})`]
        : []),
    ];
    if (deliverable.length === 0) return [];
    return db().transact(() => {
      const candidates = db().all<MessageRow & { lane: string | null }>(
        `SELECT m.* FROM messages m
         WHERE COALESCE(m.tag, '') = ? AND m.visible_at <= ?
           AND (m.lease_until IS NULL OR m.lease_until < ?)
           AND (${deliverable.join(' OR ')})
           AND (m.lane IS NULL OR NOT EXISTS (
             SELECT 1 FROM messages o
             WHERE o.lane = m.lane AND o.id <> m.id AND o.lease_until >= ?))
         ORDER BY m.visible_at, m.id
         LIMIT ?`,
        tag ?? '',
        now,
        now,
        ...prefixes,
        now,
        limit * 2
      );
      const lanes = new Set<string>();
      const claimed: MessageRow[] = [];
      for (const candidate of candidates) {
        if (claimed.length === limit) break;
        if (candidate.lane !== null) {
          if (lanes.has(candidate.lane)) continue;
          lanes.add(candidate.lane);
        }
        db().run(
          'UPDATE messages SET lease_owner = ?, lease_until = ? WHERE id = ?',
          leaseOwner,
          now + LEASE_MS,
          candidate.id
        );
        claimed.push(candidate);
      }
      return claimed;
    });
  }

  /** Delay until the next message becomes visible, capped at the poll. */
  function nextWakeMs(): number {
    const row = db().get<{ next: number | null }>(
      `SELECT MIN(MAX(visible_at, COALESCE(lease_until, 0))) AS next FROM messages
       WHERE COALESCE(tag, '') = ?`,
      tag ?? ''
    );
    if (row?.next === null || row?.next === undefined) return POLL_INTERVAL_MS;
    return Math.max(
      0,
      Math.min(POLL_INTERVAL_MS, Number(row.next) - queueNow())
    );
  }

  function renewLeases(): void {
    if (inflight.size === 0) return;
    const ids = [...inflight.keys()];
    db().run(
      `UPDATE messages SET lease_until = ? WHERE lease_owner = ? AND id IN (${ids
        .map(() => '?')
        .join(', ')})`,
      queueNow() + LEASE_MS,
      leaseOwner,
      ...ids
    );
  }

  async function consume(): Promise<void> {
    let lastRenew = queueNow();
    while (!closeSignal.aborted) {
      try {
        if (queueNow() - lastRenew >= LEASE_RENEW_MS) {
          renewLeases();
          lastRenew = queueNow();
        }
        const capacity = concurrency - inflight.size;
        let claimed: MessageRow[] = [];
        if (capacity > 0) {
          const canHttp = (await httpBaseUrl()) !== undefined;
          // Closed while resolving: touch nothing more (the data directory
          // may be on its way out).
          if (closeSignal.aborted) return;
          claimed = claim(Math.min(capacity, 100), canHttp);
          for (const message of claimed) {
            const controller = new AbortController();
            inflight.set(message.id, controller);
            void deliver(message, controller.signal)
              .catch((error) => {
                if (!closeSignal.aborted) {
                  console.error('[local world] Queue operation failed:', error);
                }
              })
              .finally(() => {
                inflight.delete(message.id);
                wakeConsumer();
              });
          }
          if (claimed.length === Math.min(capacity, 100)) continue;
        }
        const delay = capacity > 0 ? nextWakeMs() : POLL_INTERVAL_MS;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(delay, 1));
          // An idle consumer never keeps the process alive: a message is
          // durable, and the next process to use the World delivers it.
          timer.unref?.();
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
          closeSignal.addEventListener('abort', wake, { once: true });
        });
      } catch (error) {
        if (closeSignal.aborted) return;
        console.error('[world-local] Queue consumer error, retrying', error);
        await sleep(POLL_INTERVAL_MS * 10, undefined, { ref: false }).catch(
          () => {}
        );
      }
    }
  }

  function startConsumer(): void {
    if (consumerStarted || closeSignal.aborted) return;
    consumerStarted = true;
    void consume();
  }

  // ------------------------------------------------------------- deliveries

  function settle(
    id: string,
    update: {
      visibleAt: number;
      deliveries?: number;
      handoffs?: number;
      failures?: number;
    }
  ): void {
    // After close() the message was handed back already; a delivery that
    // finishes afterwards leaves it to the next consumer.
    if (closeSignal.aborted) return;
    db().run(
      `UPDATE messages SET visible_at = ?, lease_owner = NULL, lease_until = NULL,
         deliveries = COALESCE(?, deliveries), handoffs = COALESCE(?, handoffs),
         failures = COALESCE(?, failures)
       WHERE id = ? AND lease_owner = ?`,
      update.visibleAt,
      update.deliveries ?? null,
      update.handoffs ?? null,
      update.failures ?? null,
      id,
      leaseOwner
    );
  }

  function remove(id: string): void {
    if (closeSignal.aborted) return;
    db().run(
      'DELETE FROM messages WHERE id = ? AND lease_owner = ?',
      id,
      leaseOwner
    );
  }

  async function deliver(
    message: MessageRow,
    signal: AbortSignal
  ): Promise<void> {
    const { id: messageId, queue_name: queueName, prefix } = message;
    const runId = message.run_id ?? undefined;
    const stepId = message.step_id ?? undefined;
    const deliveries = Number(message.deliveries);
    const handoffs = Number(message.handoffs);
    const failures = Number(message.failures);
    const context = {
      queueName,
      messageId,
      ...(runId && { runId }),
      ...(stepId && { stepId }),
    };

    if (deliveries - handoffs >= MAX_LOCAL_SAFETY_LIMIT) {
      console.error(
        `[world-local] Queue message exhausted safety limit (${MAX_LOCAL_SAFETY_LIMIT} attempts)`,
        context
      );
      remove(messageId);
      return;
    }

    const headers: Record<string, string> = {
      ...(message.headers
        ? (JSON.parse(message.headers) as Record<string, string>)
        : {}),
      'content-type': 'application/json',
      'x-vqs-queue-name': queueName,
      'x-vqs-message-id': messageId,
      'x-vqs-message-attempt': String(deliveries + 1 - handoffs),
      'x-vqs-message-delivery-count': String(deliveries + 1),
      'x-vqs-message-created-at': message.created_at,
    };
    const body = Buffer.from(message.body);
    const directHandler = directHandlers.get(prefix);

    let response: Response;
    let text: string;
    try {
      if (directHandler) {
        response = await directHandler(
          new Request(deliveryUrl(resolveDirectBaseUrl(config), prefix), {
            method: 'POST',
            headers,
            body,
          })
        );
      } else {
        const url = deliveryUrl(await resolveBaseUrl(config), prefix);
        const abort = AbortSignal.any([closeSignal, signal]);
        response = nodeHttpAgents
          ? await nodeHttpFetch(url, {
              method: 'POST',
              headers: new Headers(headers),
              body,
              agents: nodeHttpAgents,
              signal: abort,
              headersTimeoutMs: agentOptions.headersTimeout,
              bodyTimeoutMs: agentOptions.bodyTimeout,
            })
          : await fetch(url, {
              method: 'POST',
              duplex: 'half',
              dispatcher: httpAgent,
              headers,
              body,
              signal: abort,
            } as any);
      }
      text = await response.text();
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      if (
        closeSignal.aborted ||
        name === 'AbortError' ||
        name === 'ResponseAborted'
      ) {
        // Shutting down: hand the message back for the next consumer.
        settle(messageId, { visibleAt: queueNow() });
        return;
      }
      if (isDetachedArrayBufferQueueError(error)) {
        console.error(
          `[local world] Queue operation failed: detected "${DETACHED_ARRAYBUFFER_ERROR}". ` +
            "This usually means a Next.js proxy/middleware consumed Workflow's internal " +
            'request before the executor could read it. Exclude `/.well-known/workflow/*` ' +
            `from your matcher. See ${PROXY_HANDLER_DOCS_URL}`,
          { ...context, originalError: error }
        );
        remove(messageId);
        return;
      }
      // A transport failure (before the response, or while reading it) is
      // transient: retry the same message.
      console.error(
        '[world-local] Queue delivery failed at the transport, retrying',
        { ...context, error: String(error) }
      );
      if (!directHandler) baseUrl = { retryAt: 0 };
      settle(messageId, { visibleAt: queueNow() + TRANSPORT_RETRY_DELAY_MS });
      return;
    }

    const delivered = deliveries + 1;
    if (response.ok) {
      try {
        const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
        if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
          if (timeoutSeconds > 0) {
            settle(messageId, {
              visibleAt:
                queueNow() +
                Math.min(timeoutSeconds * 1000, MAX_SAFE_TIMEOUT_MS),
              deliveries: delivered,
            });
          } else {
            // On a single-orchestrator run, `{ timeoutSeconds: 0 }` is a
            // handoff: redelivered at once, and not counted as an attempt.
            const handsOff =
              message.hands_off === 1 && handoffs < MAX_LOCAL_HANDOFFS;
            settle(messageId, {
              visibleAt: queueNow(),
              deliveries: delivered,
              handoffs: handsOff ? handoffs + 1 : handoffs,
            });
          }
          return;
        }
      } catch {}
      remove(messageId);
      return;
    }

    console.error(
      `[world-local] Queue message failed (attempt ${delivered - handoffs}, HTTP ${response.status})`,
      {
        ...context,
        handlerError: text,
        ...(!directHandler &&
          !routes.has(prefix) &&
          (response.status === 400 || response.status === 404) && {
            hint:
              `No route or handler is registered for queue prefix "${prefix}", ` +
              `so its messages go to the Workflow SDK's flow route (${WORKFLOW_FLOW_ROUTE}). ` +
              `A queue consumer of its own registers one with world.registerRoute(prefix, path) or world.registerHandler(prefix, handler).`,
          }),
      }
    );
    if (delivered - handoffs >= MAX_LOCAL_SAFETY_LIMIT) {
      console.error(
        `[world-local] Queue message exhausted safety limit (${MAX_LOCAL_SAFETY_LIMIT} attempts)`,
        context
      );
      remove(messageId);
      return;
    }
    settle(messageId, {
      visibleAt: queueNow() + localRetryDelayMs(failures + 1),
      deliveries: delivered,
      failures: failures + 1,
    });
  }

  // ------------------------------------------------------------------ queue

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    if (closeSignal.aborted) {
      throw new Error('world-local queue is closed');
    }
    const { prefix } = parseQueueName(queueName);
    const body = transport.serialize(message).toString();
    const msg = message as Record<string, unknown>;
    const runId = typeof msg.runId === 'string' ? msg.runId : undefined;
    const stepId = typeof msg.stepId === 'string' ? msg.stepId : undefined;
    const orchestratorRunId = singleOrchestratorRunIdOf(message);
    const lane =
      orchestratorRunId === undefined ? null : `${prefix}${orchestratorRunId}`;
    const delayMs =
      opts?.delaySeconds && opts.delaySeconds > 0
        ? Math.min(opts.delaySeconds * 1000, MAX_SAFE_TIMEOUT_MS)
        : 0;

    const messageId = db().transact(() => {
      if (opts?.idempotencyKey) {
        const existing = db().get<{ id: string }>(
          `SELECT id FROM messages WHERE COALESCE(tag, '') = ? AND idempotency_key = ?`,
          tag ?? '',
          opts.idempotencyKey
        );
        if (existing) return MessageId.parse(existing.id);
      }
      const id = MessageId.parse(`msg_${generateId()}`);
      db().run(
        `INSERT INTO messages (id, tag, queue_name, prefix, transport, body, headers,
           idempotency_key, lane, hands_off, run_id, step_id, visible_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        tag ?? null,
        queueName,
        prefix,
        directHandlers.has(prefix) ? 'direct' : 'http',
        body,
        opts?.headers ? JSON.stringify(opts.headers) : null,
        opts?.idempotencyKey ?? null,
        lane,
        isSingleOrchestratorMessage(message) ? 1 : 0,
        runId ?? null,
        stepId ?? null,
        queueNow() + delayMs,
        new Date(queueNow()).toISOString()
      );
      return id;
    });
    startConsumer();
    wakeConsumer();
    return { messageId };
  };

  const HeaderParser = z.compile(
    z.object({
      'x-vqs-queue-name': ValidQueueName,
      'x-vqs-message-id': MessageId,
      'x-vqs-message-attempt': z.coerce.number(),
      // Sent by world-postgres, whose `attempt` restarts on a reschedule.
      'x-vqs-message-delivery-count': z.coerce
        .number()
        .int()
        .positive()
        .optional(),
      // Absent on a delivery from a sender that predates it.
      'x-vqs-message-created-at': z.iso.datetime().optional(),
    })
  );

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
      const deliveryCountHeader = headers.data['x-vqs-message-delivery-count'];
      const createdAtHeader = headers.data['x-vqs-message-created-at'];

      if (!queueName.startsWith(prefix)) {
        return Response.json(
          {
            error: 'Unhandled queue',
            detail: `This route handles queue prefix "${prefix}", not "${queueName}".`,
          },
          { status: 400 }
        );
      }

      const body = await new TypedJsonTransport().deserialize(req.body);
      const orchestratorRunId = singleOrchestratorRunIdOf(body);
      const releaseRun =
        orchestratorRunId === undefined
          ? undefined
          : await handlerRunGate.acquire(`${prefix}${orchestratorRunId}`);
      try {
        const result = await handler(body, {
          attempt,
          deliveryCount: deliveryCountHeader ?? attempt,
          ...(createdAtHeader ? { createdAt: new Date(createdAtHeader) } : {}),
          queueName,
          messageId,
        });

        if (
          typeof body === 'object' &&
          body !== null &&
          'invoke' in body &&
          body.invoke === true
        ) {
          return Response.json({ result });
        }

        let timeoutSeconds: number | null = null;
        if (
          typeof result === 'object' &&
          result !== null &&
          'timeoutSeconds' in result &&
          typeof result.timeoutSeconds === 'number'
        ) {
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
      } finally {
        releaseRun?.();
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
    registerHandler(prefix: QueuePrefix, handler: DirectHandler) {
      directHandlers.set(prefix, handler);
      if (consumerStarted) wakeConsumer();
    },
    registerRoute(prefix: QueuePrefix, path: string) {
      routes.set(QueuePrefix.parse(prefix), parseQueueRoute(path));
    },
    startConsumer,
    runsWithMessages(runIds) {
      if (runIds.length === 0) return new Set();
      const rows = db().all<{ run_id: string }>(
        `SELECT DISTINCT run_id FROM messages WHERE run_id IN (${runIds
          .map(() => '?')
          .join(', ')})`,
        ...runIds
      );
      return new Set(rows.map((row) => row.run_id));
    },
    async close() {
      // Idempotent: shutdown paths may close the queue more than once.
      if (closeSignal.aborted) return;
      closeController.abort();
      wakeConsumer();
      for (const controller of inflight.values()) controller.abort();
      if (database && inflight.size > 0) {
        // Hand in-flight messages back at once rather than after the lease.
        const ids = [...inflight.keys()];
        try {
          db().run(
            `UPDATE messages SET lease_owner = NULL, lease_until = NULL
             WHERE lease_owner = ? AND id IN (${ids.map(() => '?').join(', ')})`,
            leaseOwner,
            ...ids
          );
        } catch {}
      }
      if (nodeHttpAgents) destroyNodeHttpAgents(nodeHttpAgents);
      await httpAgent?.close();
    },
  };
}
