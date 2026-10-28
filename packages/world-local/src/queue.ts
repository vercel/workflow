import { setTimeout } from 'node:timers/promises';
import type { Transport } from '@vercel/queue';
import {
  createAppRouteUrl,
  createWorkflowUrl,
  debugLog,
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
import { Sema } from 'async-sema';
import { monotonicFactory } from 'ulid';
import { Agent } from 'undici';
import { z } from 'zod/v4';
import type { Config } from './config.js';
import { resolveBaseUrl, resolveDirectBaseUrl } from './config.js';
import { jsonReplacer, jsonReviver } from './fs.js';
import { getPackageInfo } from './init.js';

/**
 * JSON transport that preserves Uint8Array values using the same
 * replacer/reviver that world-local uses for filesystem storage.
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
    const text = Buffer.concat(chunks).toString();
    return JSON.parse(text, jsonReviver);
  }
}

// For local queue, there is no technical limit on the message visibility lifespan,
// but the environment variable can be used for testing purposes to set a max visibility limit.
const LOCAL_QUEUE_MAX_VISIBILITY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_MAX_VISIBILITY ?? '0', 10) ||
  Infinity;

// Maximum safe delay for setTimeout in Node.js (2^31 - 1 milliseconds ≈ 24.85 days)
// Larger values cause "TimeoutOverflowWarning: X does not fit into a 32-bit signed integer"
// When the clamped timeout fires, the handler will recalculate remaining time from
// persistent state and return another timeoutSeconds if needed.
const MAX_SAFE_TIMEOUT_MS = 2147483647;

/**
 * The most deliveries world-local makes of one message (handoffs aside): a
 * guard against a message that fails forever. The runtime enforces its own
 * delivery cap well below it.
 */
export const MAX_LOCAL_SAFETY_LIMIT = 256;

/** Failed deliveries retried 5s apart, before the backoff grows. */
const LINEAR_RETRY_DELIVERIES = 32;
const LINEAR_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * The delay before world-local retries a message whose `failedDeliveries`-th
 * delivery failed: 5s for the first 32, as Vercel Queues does, then doubling
 * up to a minute. So the {@link MAX_LOCAL_SAFETY_LIMIT} deliveries of a
 * message that keeps failing span hours, longer than the runtime's stall
 * window for a step message (`QUEUE_MIN_STEP_REDELIVERY_SPAN_MS` in
 * `@workflow/world`), and a step whose every delivery throws is failed
 * rather than left with no message.
 */
export function localRetryDelayMs(failedDeliveries: number): number {
  if (failedDeliveries <= LINEAR_RETRY_DELIVERIES) return LINEAR_RETRY_DELAY_MS;
  return Math.min(
    MAX_RETRY_DELAY_MS,
    LINEAR_RETRY_DELAY_MS * 2 ** (failedDeliveries - LINEAR_RETRY_DELIVERIES)
  );
}

// The local workers share the same Node.js process and event loop,
// so we need to limit concurrency to avoid overwhelming the system.
const DEFAULT_CONCURRENCY_LIMIT = 1000;

const WORKFLOW_LOCAL_QUEUE_CONCURRENCY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY ?? '0', 10) ||
  DEFAULT_CONCURRENCY_LIMIT;

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
 * retried by the delivery loop with the same durable message, so the deadline
 * must exceed the longest inline step.
 *
 * Both transports honor every field. Over undici this is the `Agent`'s own
 * configuration; over `node:http` (`WORKFLOW_NODE_HTTP`) the two timeouts are
 * passed per request and `connections` / `keepAliveTimeout` size the socket
 * pool, so the two env vars tune a delivery identically either way.
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
  /** Close the HTTP agent and release resources. */
  close(): Promise<void>;
  /** Register a direct in-process handler for a queue prefix, bypassing HTTP. */
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  /**
   * Route a queue prefix's HTTP deliveries to `path` on the app instead of
   * the Workflow SDK's flow route (see `Queue.registerRoute`).
   */
  registerRoute(prefix: QueuePrefix, path: string): void;
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
 * Per-run mutual exclusion for orchestrator deliveries, in FIFO order.
 *
 * `acquire(runId)` resolves once every earlier holder for that run has
 * released, with the release function. Keys are dropped when the last holder
 * releases, so the map holds only runs with a delivery in flight or waiting.
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

export function createQueue(config: Partial<Config>): LocalQueue {
  // Exactly one of these is built, and close() shuts down whichever it is.
  // Resolved once per queue rather than per delivery so a single queue never
  // mixes transports mid-flight.
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
  const semaphore = new Sema(WORKFLOW_LOCAL_QUEUE_CONCURRENCY);
  // A single-orchestrator run's (spec >= 9) orchestrator deliveries go one at
  // a time, like a concurrency key on Vercel Queues: the single-writer
  // guarantee's queue half (the in-band fence is the other). Step messages,
  // health checks and earlier runs' messages are not gated (see
  // `singleOrchestratorRunIdOf`), so a run's steps keep running in parallel
  // with each other and with its orchestrator.
  const runGate = createRunGate();

  // Aborted by close(): cancels every pending sleep (delayed deliveries,
  // timeoutSeconds re-deliveries, retry backoffs) so shutdown isn't held
  // hostage by a timer and no delivery is attempted against the closed
  // agent. The resulting AbortError is silently dropped by the
  // isAbortError check in the delivery catch handler.
  const closeController = new AbortController();
  const closeSignal = closeController.signal;

  /**
   * holds inflight messages by idempotency key to ensure
   * that we don't queue the same message multiple times
   */
  const inflightMessages = new Map<string, MessageId>();
  /** Direct in-process handlers by queue prefix, bypassing HTTP when set. */
  const directHandlers = new Map<string, DirectHandler>();
  /**
   * HTTP delivery routes by queue prefix. A prefix without one is delivered
   * to the Workflow SDK's flow route. Read on every delivery attempt, so a
   * route registered after a message was enqueued (a consumer whose module
   * loads after `start()` re-enqueued its runs) takes the next attempt.
   */
  const routes = new Map<string, string>();
  const deliveryUrl = (baseUrl: string, prefix: string) => {
    const route = routes.get(prefix);
    return route
      ? createAppRouteUrl(baseUrl, route)
      : createWorkflowUrl(baseUrl, { type: 'flow' });
  };

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const cleanup = [] as (() => void)[];

    if (opts?.idempotencyKey) {
      const existing = inflightMessages.get(opts.idempotencyKey);
      if (existing) {
        return { messageId: existing };
      }
    }

    const body = transport.serialize(message);
    const { prefix } = parseQueueName(queueName);
    const messageId = MessageId.parse(`msg_${generateId()}`);
    // One message for its whole life: every delivery below, including the
    // `{ timeoutSeconds }` redeliveries, reuses this id and creation time.
    const createdAt = new Date().toISOString();

    // Extract identifiers from the message for structured logging.
    // Combined workflow messages carry `runId` and may include `stepId`.
    const msg = message as Record<string, unknown>;
    const runId = (msg.runId ?? undefined) as string | undefined;
    const stepId = (msg.stepId ?? undefined) as string | undefined;
    // Keyed by prefix as well, so a run id never gates deliveries on another
    // prefix (a queue consumer of its own, or another namespace).
    const orchestratorRunKey = (() => {
      const id = singleOrchestratorRunIdOf(message);
      return id === undefined ? undefined : `${prefix}${id}`;
    })();
    // On a single-orchestrator run, `{ timeoutSeconds: 0 }` is a handoff: the
    // redelivery starts at once and the handed-off delivery is not an attempt.
    const handsOff = isSingleOrchestratorMessage(message);

    if (opts?.idempotencyKey) {
      const key = opts.idempotencyKey;
      inflightMessages.set(key, messageId);
      cleanup.push(() => {
        inflightMessages.delete(key);
      });
    }

    (async () => {
      // Honor the caller's requested delivery delay before acquiring a queue
      // slot. Sleeping outside the semaphore so a delayed message doesn't
      // hold a worker hostage for its delay window: the worker should be
      // free to process other (immediate) messages until this one is ready.
      // VQS-side queues honor delaySeconds at the broker, so this brings
      // world-local in line with production behavior.
      if (opts?.delaySeconds && opts.delaySeconds > 0) {
        const delayMs = Math.min(opts.delaySeconds * 1000, MAX_SAFE_TIMEOUT_MS);
        await setTimeout(delayMs, undefined, { signal: closeSignal });
      }

      /**
       * Takes this message's delivery slots: its run's orchestrator gate
       * first (when it is an orchestrator delivery), then a worker slot. The
       * gate is taken first so a delivery waiting for its run holds no worker
       * slot. Both are held for one delivery attempt only and released before
       * any sleep (a `{ timeoutSeconds }` redelivery delay, a retry backoff),
       * because a message that is not being delivered occupies neither, as on
       * Vercel Queues.
       */
      const acquireDelivery = async (): Promise<() => void> => {
        const releaseRun = orchestratorRunKey
          ? await runGate.acquire(orchestratorRunKey)
          : undefined;
        if (!semaphore.tryAcquire()) {
          // Debug-gated: this is the semaphore doing its job. A fan-out wider
          // than the limit queues behind it and every message still runs, so
          // a per-message warning turns a healthy wide run into a wall of
          // output.
          debugLog(
            `[world-local]: concurrency limit (${WORKFLOW_LOCAL_QUEUE_CONCURRENCY}) reached, waiting for queue to free up`
          );
          await semaphore.acquire();
        }
        return () => {
          semaphore.release();
          releaseRun?.();
        };
      };
      // Handoffs counted as such per message, as Vercel Queues bounds them;
      // past it a handoff counts toward `attempt` and the safety limit.
      const MAX_LOCAL_HANDOFFS = 10_000;
      // Number of times the message has actually reached a handler (returned
      // ok, a timeoutSeconds re-delivery, or an HTTP error response). This,
      // not the loop counter, is the attempt the handler sees via
      // `x-vqs-message-attempt`, which it counts against MAX_QUEUE_DELIVERIES.
      // Failures before response headers do not advance this; body failures do,
      // because the handler has already accepted that delivery.
      let delivery = 0;
      // Deliveries that ended in a handoff, which `attempt` and the safety
      // limit leave out.
      let handoffs = 0;
      // Deliveries whose handler answered with an error.
      let failedDeliveries = 0;
      let releaseDelivery: (() => void) | undefined;
      const endDelivery = () => {
        releaseDelivery?.();
        releaseDelivery = undefined;
      };
      try {
        for (let loop = 0; loop - handoffs < MAX_LOCAL_SAFETY_LIMIT; loop++) {
          releaseDelivery = await acquireDelivery();
          if (closeSignal.aborted) return;
          const headers: Record<string, string> = {
            ...opts?.headers,
            'content-type': 'application/json',
            'x-vqs-queue-name': queueName,
            'x-vqs-message-id': messageId,
            'x-vqs-message-attempt': String(delivery + 1 - handoffs),
            'x-vqs-message-delivery-count': String(delivery + 1),
            'x-vqs-message-created-at': createdAt,
          };
          const directHandler = directHandlers.get(prefix);
          let response: Response;
          let text: string;

          try {
            if (directHandler) {
              const req = new Request(
                deliveryUrl(resolveDirectBaseUrl(config), prefix),
                { method: 'POST', headers, body }
              );
              response = await directHandler(req);
            } else {
              const baseUrl = await resolveBaseUrl(config);
              const url = deliveryUrl(baseUrl, prefix);
              response = nodeHttpAgents
                ? await nodeHttpFetch(url, {
                    method: 'POST',
                    headers: new Headers(headers),
                    body,
                    agents: nodeHttpAgents,
                    signal: closeSignal,
                    headersTimeoutMs: agentOptions.headersTimeout,
                    bodyTimeoutMs: agentOptions.bodyTimeout,
                  })
                : // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici v7 dispatcher types don't match @types/node's RequestInit
                  await fetch(url, {
                    method: 'POST',
                    duplex: 'half',
                    dispatcher: httpAgent,
                    headers,
                    body,
                    signal: closeSignal,
                  } as any);
            }
            delivery++;
            text = await response.text();
          } catch (err) {
            endDelivery();
            // A transport can fail before response headers or while consuming
            // the body. Both are transient: back off and retry the same
            // durable message rather than leaving its run stalled. Two
            // failures are not retryable:
            //  - shutdown: close() aborted the agent / the backoff sleep.
            //  - a detached-ArrayBuffer proxy misconfig, which never succeeds:
            //    rethrow so the outer catch surfaces the actionable guidance.
            const name = (err as { name?: string } | undefined)?.name;
            if (
              closeSignal.aborted ||
              name === 'AbortError' ||
              name === 'ResponseAborted'
            ) {
              return;
            }
            if (isDetachedArrayBufferQueueError(err)) throw err;

            console.error(
              `[world-local] Queue delivery failed at the transport (loop ${loop + 1}), retrying`,
              {
                queueName,
                messageId,
                ...(runId && { runId }),
                ...(stepId && { stepId }),
                error: String(err),
              }
            );
            await setTimeout(5000, undefined, { signal: closeSignal });
            continue;
          }

          endDelivery();
          if (response.ok) {
            try {
              const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
              if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
                // Clamp to MAX_SAFE_TIMEOUT_MS to avoid Node.js setTimeout overflow warning.
                // When this fires early, the handler recalculates remaining time from
                // persistent state and returns another timeoutSeconds if needed.
                if (timeoutSeconds > 0) {
                  const timeoutMs = Math.min(
                    timeoutSeconds * 1000,
                    MAX_SAFE_TIMEOUT_MS
                  );
                  await setTimeout(timeoutMs, undefined, {
                    signal: closeSignal,
                  });
                } else if (handsOff && handoffs < MAX_LOCAL_HANDOFFS) {
                  handoffs++;
                }
                continue;
              }
            } catch {}
            return;
          }

          console.error(
            `[world-local] Queue message failed (attempt ${delivery}, HTTP ${response.status})`,
            {
              queueName,
              messageId,
              ...(runId && { runId }),
              ...(stepId && { stepId }),
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

          // Backs off as VQS does (see `localRetryDelayMs`).
          failedDeliveries++;
          await setTimeout(localRetryDelayMs(failedDeliveries), undefined, {
            signal: closeSignal,
          });
        }

        console.error(
          `[world-local] Queue message exhausted safety limit (${MAX_LOCAL_SAFETY_LIMIT} attempts)`,
          {
            queueName,
            messageId,
            ...(runId && { runId }),
            ...(stepId && { stepId }),
          }
        );
      } finally {
        endDelivery();
      }
    })()
      .catch((err) => {
        // Silently ignore client disconnect errors (e.g., browser refresh during streaming)
        // These are expected and should not cause unhandled rejection warnings
        const isAbortError =
          err?.name === 'AbortError' || err?.name === 'ResponseAborted';
        if (!isAbortError) {
          if (isDetachedArrayBufferQueueError(err)) {
            console.error(
              `[local world] Queue operation failed: detected "${DETACHED_ARRAYBUFFER_ERROR}". ` +
                "This usually means a Next.js proxy/middleware consumed Workflow's internal " +
                'request before the executor could read it. Exclude `/.well-known/workflow/*` ' +
                `from your matcher. See ${PROXY_HANDLER_DOCS_URL}`,
              {
                queueName,
                messageId,
                ...(runId && { runId }),
                ...(stepId && { stepId }),
                originalError: err,
              }
            );
          } else {
            console.error('[local world] Queue operation failed:', err);
          }
        }
      })
      .finally(() => {
        for (const fn of cleanup) {
          fn();
        }
      });

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
      try {
        const result = await handler(body, {
          attempt,
          // Counts every delivery of this message that reached a handler,
          // starting at 1, including `{ timeoutSeconds }` redeliveries.
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
    },
    registerRoute(prefix: QueuePrefix, path: string) {
      routes.set(QueuePrefix.parse(prefix), parseQueueRoute(path));
    },
    async close() {
      // Idempotent: shutdown paths (CLI signal handlers, test teardown)
      // may close the queue more than once.
      if (closeSignal.aborted) return;
      closeController.abort();
      if (nodeHttpAgents) destroyNodeHttpAgents(nodeHttpAgents);
      await httpAgent?.close();
    },
  };
}
