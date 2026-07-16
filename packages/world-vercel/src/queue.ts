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
import { decode as cborDecode, encode as cborEncode } from 'cbor-x';
import { z } from 'zod/v4';
import { getDispatcher } from './http-client.js';
import { decode as decodeTaggedRunId } from './run-id/index.js';
import { isKnownRegionCode, REGION_IDS } from './run-id/regions.js';
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
    return Buffer.from(cborEncode(value));
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return cborDecode(Buffer.concat(chunks));
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
    return Buffer.from(cborEncode(value));
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
      return cborDecode(buffer);
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
 * - Fresh default 24-hour TTL with each message (no message age tracking needed)
 * - Messages fire at the scheduled time (no short-circuit + recheck pattern)
 * - Simpler conceptual model: messages are triggers with delivery schedules
 *
 * For sleeps longer than one continuation hop, we use chaining:
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
  process.env.VERCEL_QUEUE_MAX_DELAY_SECONDS || 82800 // 23 hours - leave 1h buffer before the default 24h message TTL
);

const HANDLER_ERROR_RETRY_AFTER_SECONDS = 1;
// Ceiling for the per-redelivery backoff. This value is the `retry-after` we
// hand to VQS, which clamps it into [5s, MAX_SQS_DELAY_SECONDS=900s] for the
// first 32 deliveries and then applies its own exponential growth (also capped
// at 900s) — see vqs-server `calculateBackoffDelay`. Capping our base at 60s
// (the old value) wasted that headroom: a run stuck behind a sustained backend
// outage exhausted its delivery budget in ~3.7h. Ramping to the 900s ceiling
// instead stretches survival to ~9–10h (across `MAX_QUEUE_DELIVERIES` = 48
// attempts), so transient outages don't fail otherwise-healthy runs. Spanning
// the full ~24h message-visibility window would require a higher delivery cap,
// not a higher ceiling — VQS clamps every hop at 900s, so going above it here
// is pointless.
const HANDLER_ERROR_MAX_RETRY_AFTER_SECONDS = 900;
const HANDLER_ERROR_RETRY_JITTER_RATIO = 0.25;

function getHandlerErrorRetryAfterSeconds(deliveryCount: number): number {
  const backoffSeconds = Math.min(
    Math.max(HANDLER_ERROR_RETRY_AFTER_SECONDS, 2 ** (deliveryCount - 1)),
    HANDLER_ERROR_MAX_RETRY_AFTER_SECONDS
  );
  const jitterSeconds = Math.floor(
    Math.random() *
      (Math.ceil(backoffSeconds * HANDLER_ERROR_RETRY_JITTER_RATIO) + 1)
  );
  return Math.max(
    HANDLER_ERROR_RETRY_AFTER_SECONDS,
    backoffSeconds - jitterSeconds
  );
}

/**
 * Default region used when no explicit override, no tagged run ID, and no
 * `VERCEL_REGION` env var are available. `iad1` preserves the historical
 * behaviour from before per-message regional routing existed.
 */
const FALLBACK_REGION = 'iad1';

/**
 * Extract the workflow run ID from a queue payload, returning `undefined` for
 * payloads that don't carry one (e.g. health-check messages).
 */
function getRunIdFromPayload(payload: QueuePayload): string | undefined {
  if ('runId' in payload && typeof payload.runId === 'string') {
    return payload.runId;
  }
  if ('workflowRunId' in payload && typeof payload.workflowRunId === 'string') {
    return payload.workflowRunId;
  }
  return undefined;
}

/**
 * Workflow run IDs are prefixed with `wrun_` before the underlying ULID.
 * Strip that prefix so the payload can be fed to the tagged-ULID decoder.
 */
const RUN_ID_PREFIX = 'wrun_';

/**
 * Decode the embedded region from a tagged workflow run ID, returning
 * `undefined` if the value is not a tagged ULID or carries an unknown region.
 */
function regionFromTaggedRunId(runId: string | undefined): string | undefined {
  if (!runId) return undefined;
  const ulid = runId.startsWith(RUN_ID_PREFIX)
    ? runId.slice(RUN_ID_PREFIX.length)
    : runId;
  try {
    const decoded = decodeTaggedRunId(ulid);
    if (!decoded.tagged) return undefined;
    if (decoded.regionId === REGION_IDS.unknown) return undefined;
    return decoded.region ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the region the message should be sent to, in order of preference:
 *   1. Explicit `opts.region` override.
 *   2. Region embedded in the payload's tagged run ID.
 *   3. `VERCEL_REGION` environment variable.
 *   4. {@link FALLBACK_REGION} (preserves pre-regional behaviour).
 *
 * The `opts.region` override and `VERCEL_REGION` are arbitrary strings, so
 * each is validated against the known region table and ignored (falling
 * through to the next source) when it isn't a routable region code. This keeps
 * a bad override — e.g. `start({ region: 'xyz9' })` — from
 * clobbering the payload-derived region with an undeliverable destination.
 */
function resolveTargetRegion(
  payload: QueuePayload,
  opts?: QueueOptions
): string {
  if (isKnownRegionCode(opts?.region)) return opts.region;
  const fromRunId = regionFromTaggedRunId(getRunIdFromPayload(payload));
  if (fromRunId) return fromRunId;
  const fromEnv = process.env.VERCEL_REGION;
  if (isKnownRegionCode(fromEnv)) return fromEnv;
  return FALLBACK_REGION;
}

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

/**
 * Resolves the physical VQS topic for a message.
 *
 * Normally this is just the logical queue name. When
 * `WORKFLOW_SEQUENTIAL_REPLAYS` is enabled, messages on flow (workflow)
 * topics get a payload-dependent physical topic. VQS scopes `maxConcurrency`
 * per concrete topic, so combined with `maxConcurrency: 1` on the flow
 * trigger:
 *
 * - Orchestrator replays (`WorkflowInvokePayload` without a `stepId`) get a
 *   per-run topic — at most one replay per run at a time.
 * - Inline step executions (`WorkflowInvokePayload` WITH a `stepId` — they
 *   ride the flow topic in the combined handler model) get a per-step topic
 *   so steps keep full parallelism across a run; only redeliveries of the
 *   same step serialize.
 * - Health checks get a per-probe topic (their correlation id) so concurrent
 *   probes never queue behind one shared `…_health_check` slot.
 *
 * Legacy `*_wkf_step_*` topics are intentionally excluded.
 *
 * The flow-topic match allows an optional queue namespace prefix
 * (`__<namespace>_wkf_workflow_`, see `@workflow/builders` constants) so the
 * behavior composes with `WORKFLOW_QUEUE_NAMESPACE`.
 *
 * This rewrite only serializes messages sent through this adapter (the
 * wrapper's logical `queueName` keeps handler dispatch and re-enqueues on the
 * same physical topic). A producer that computes the shared topic name itself
 * still delivers (the trigger subscribes with a wildcard), but bypasses the
 * per-run concurrency slot.
 */
const FLOW_TOPIC_PATTERN = /^__([a-z][a-z0-9]*_)?wkf_workflow_/;

let loggedSequentialReplays = false;

/**
 * Whether sequential replays are enabled (`WORKFLOW_SEQUENTIAL_REPLAYS=1`).
 * Mirrors `isSequentialReplaysEnabled` in `@workflow/builders` — world-vercel
 * must not depend on the build-time package, so the check is duplicated.
 */
function isSequentialReplaysEnabled(): boolean {
  return process.env.WORKFLOW_SEQUENTIAL_REPLAYS === '1';
}

function getPhysicalQueueName(
  queueName: ValidQueueName,
  payload: QueuePayload
): string {
  if (!isSequentialReplaysEnabled() || !FLOW_TOPIC_PATTERN.test(queueName)) {
    return queueName;
  }
  if (!loggedSequentialReplays) {
    loggedSequentialReplays = true;
    // One-time breadcrumb so a half-applied configuration (env var set without
    // a maxConcurrency-bearing flow trigger, or vice versa) is diagnosable
    // from function logs. Must go to stderr: this code also runs inside CLI
    // commands whose stdout is a machine-parsed JSON contract (e.g.
    // `workflow health --json`).
    console.warn(
      '[workflow] WORKFLOW_SEQUENTIAL_REPLAYS=1: routing flow messages to per-run queue topics'
    );
  }
  if ('runId' in payload && typeof payload.runId === 'string') {
    // Inline step execution: full parallelism via a per-step topic.
    if ('stepId' in payload && typeof payload.stepId === 'string') {
      return `${queueName}_${payload.runId}_${payload.stepId}`;
    }
    // Orchestrator replay: serialize per run.
    return `${queueName}_${payload.runId}`;
  }
  if ('__healthCheck' in payload && typeof payload.correlationId === 'string') {
    return `${queueName}_${payload.correlationId}`;
  }
  return queueName;
}

type QueueFunction = (
  queueName: ValidQueueName,
  payload: QueuePayload,
  opts?: QueueOptions
) => ReturnType<Queue['queue']>;

export function createQueue(config?: APIConfig): Queue {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config, { usingProxy });

  const cborTransport = new CborTransport();
  const jsonTransport = new JsonTransport();
  const dualTransport = new DualTransport();

  /**
   * Options common to every `QueueClient` instantiation. `region` is
   * intentionally omitted here: `queue()` resolves it per-send from the
   * payload / opts, and the handler client leaves it unset so the SDK
   * auto-detects `VERCEL_REGION` (follow-up acks are routed to the region
   * from the incoming `ce-vqsregion` header regardless).
   */
  const clientOptions = {
    dispatcher: getDispatcher(config),
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

    // Resolve the destination region. Explicit `opts.region` wins, otherwise
    // we decode it from the payload's tagged run ID so messages produced by
    // `start()` land in the same region the run was created in. Falls back
    // to the `VERCEL_REGION` env var, then `iad1` to preserve historical
    // behaviour for legacy / untagged run IDs.
    const region = resolveTargetRegion(payload, opts);

    const client = new QueueClient({
      ...clientOptions,
      // When sending through the api.vercel.com proxy, the fixed
      // `resolveBaseUrl` above replaces the queue SDK's own
      // region -> `<region>.vercel-queue.com` base-URL resolution, so
      // the per-send resolved region must travel as a header instead:
      // the proxy forwards the send to that region's VQS dataplane
      // host when `x-vercel-queue-region` is present (vercel/api#79056).
      ...(usingProxy && {
        headers: {
          ...clientOptions.headers,
          'x-vercel-queue-region': region,
        },
      }),
      region,
      deploymentId,
      transport,
    });

    // The CborTransport handles CBOR encoding inside serialize(),
    // preserving Uint8Array values (workflow input in specVersion >= 2).
    const wrapper = {
      payload,
      // Keep the logical queue name so the handler and re-enqueue path
      // resolve the same per-run physical topic on the next invocation.
      queueName,
      // Store deploymentId in the message so it can be preserved when re-enqueueing
      deploymentId: opts?.deploymentId,
    };
    const sanitizedQueueName = getPhysicalQueueName(queueName, payload).replace(
      /[^A-Za-z0-9-_]/g,
      '-'
    );
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
          // Otherwise, clamp to one continuation hop (23h by default). Longer
          // sleeps chain delayed messages until the full duration has elapsed.
          const delaySeconds =
            result.timeoutSeconds > 0
              ? Math.min(result.timeoutSeconds, MAX_DELAY_SECONDS)
              : undefined;

          // Send new message BEFORE acknowledging current message.
          // This ensures crash safety: if process dies after send but before ack,
          // we may get a duplicate invocation but won't lose the scheduled wakeup.
          await queue(queueName, payload, { deploymentId, delaySeconds });
        }
      },
      {
        // Without an explicit retry directive, @vercel/queue leaves failed
        // handler messages invisible until the default 300s visibility timeout
        // expires. Start retrying quickly, then back off by delivery count
        // with jitter so an outage or poison message cannot hot-loop or
        // redrive in lockstep. Workflow handlers are event-sourced and must
        // remain idempotent because queue retries can happen close together.
        retry: (error, { messageId, deliveryCount }) => {
          const afterSeconds = getHandlerErrorRetryAfterSeconds(deliveryCount);
          console.error(
            `[workflow] Queue handler failed for message "${messageId}" on delivery attempt ${deliveryCount}; retrying in ${afterSeconds}s:`,
            error
          );
          return { afterSeconds };
        },
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
