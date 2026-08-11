import { z } from 'zod/v4';

export type QueueKind = 'workflow';

/**
 * Pattern matching valid queue prefixes:
 * - `__wkf_workflow_` (default, no namespace)
 * - `__{namespace}_wkf_workflow_` (namespaced)
 *
 * Namespace must be lowercase alphanumeric starting with a letter.
 */
export const QueuePrefix = z
  .string()
  .regex(
    /^__(?:[a-z][a-z0-9]*_)?wkf_workflow_$/,
    'Must match __wkf_workflow_ or __{namespace}_wkf_workflow_'
  );
export type QueuePrefix = z.infer<typeof QueuePrefix>;

export const ValidQueueName = z
  .string()
  .regex(
    /^__(?:[a-z][a-z0-9]*_)?wkf_workflow_.+$/,
    'Must be a valid queue name with a recognized prefix'
  );
export type ValidQueueName = z.infer<typeof ValidQueueName>;

const QueueNamespace = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*$/,
    'Must be lowercase alphanumeric, starting with a letter'
  );

/**
 * Resolves the active queue namespace from an explicit argument or the
 * `WORKFLOW_QUEUE_NAMESPACE` env var.
 */
export function resolveQueueNamespace(namespace?: string): string | undefined {
  return namespace ?? process.env.WORKFLOW_QUEUE_NAMESPACE ?? undefined;
}

/**
 * Builds the workflow queue topic prefix for an optional namespace.
 *
 * The literal kind argument is retained so existing workflow-only callers keep
 * their meaning after removal of the former `'step'` variant.
 *
 * - `getQueueTopicPrefix('workflow')` → `'__wkf_workflow_'`
 * - `getQueueTopicPrefix('workflow', 'custom')` → `'__custom_wkf_workflow_'`
 */
export function getQueueTopicPrefix(
  kind: QueueKind,
  namespace?: string
): QueuePrefix {
  if (kind !== 'workflow') {
    throw new Error(`Unsupported queue kind: ${kind}`);
  }
  if (namespace !== undefined) {
    QueueNamespace.parse(namespace);
    return `__${namespace}_wkf_workflow_` as QueuePrefix;
  }
  return '__wkf_workflow_' as QueuePrefix;
}

export function parseQueueName(name: ValidQueueName): {
  prefix: QueuePrefix;
  id: string;
} {
  const match = name.match(/^(__(?:[a-z][a-z0-9]*_)?wkf_workflow_)(.+)$/);

  if (!match) {
    throw new Error(`Invalid queue name: ${name}`);
  }

  return {
    prefix: QueuePrefix.parse(match[1]),
    id: match[2],
  };
}

export const MessageId = z
  .string()
  .brand<'MessageId'>()
  .describe('A stored queue message ID');
export type MessageId = z.infer<typeof MessageId>;

/**
 * OpenTelemetry trace context for distributed tracing
 */
export const TraceCarrierSchema = z.record(z.string(), z.string());
export type TraceCarrier = z.infer<typeof TraceCarrierSchema>;

/**
 * Run creation data carried through the queue for resilient start.
 * Only present on the first queue delivery — re-enqueues omit this.
 * When the runtime processes the message, it passes this data to the
 * run_started event so the server can create the run if it doesn't exist yet.
 */
export const RunInputSchema = z.object({
  input: z.unknown(),
  deploymentId: z.string(),
  workflowName: z.string(),
  specVersion: z.number(),
  executionContext: z.record(z.string(), z.any()).optional(),
  /** Initial plaintext run attributes, for resilient run creation. */
  attributes: z.record(z.string(), z.string()).optional(),
  /**
   * Permits reserved `$`-prefixed keys in `attributes`, mirrored from the
   * `start()` option so resilient run creation validates the same way as
   * the original `run_created` attempt.
   */
  allowReservedAttributes: z.literal(true).optional(),
  /**
   * The environment the creating client's writes are attributed to, as
   * reported by {@link World.getEnvironment} at `start()` time (on Vercel:
   * `'production' | 'preview' | 'development'`).
   *
   * This exists so the resilient-start path can be checked for a tenant
   * mismatch. `start()` writes `run_created` under the caller's own
   * credentials while pinning the queue message to a deployment, and those
   * two can disagree: if the message is consumed by a deployment in a
   * DIFFERENT environment, that consumer's `run_started` re-creates the run
   * under ITS tenant, so the same client-minted `wrun_` id ends up existing
   * in two environments — one stuck pending forever, the other executing.
   * Carrying the creator's environment lets the consumer compare it against
   * its own and refuse the delivery instead of forking the run.
   *
   * Absent for worlds with no environment dimension (local, Postgres), and
   * for older SDKs — consumers must treat it as advisory and skip the check
   * when it is missing.
   */
  environment: z.string().optional(),
});
export type RunInput = z.infer<typeof RunInputSchema>;

/**
 * Lazy hook resume data carried through the queue alongside a workflow
 * invocation. Present only when `resumeHook()` takes the parallel fast path:
 * the producer persists the `hook_received` event and publishes this invocation
 * concurrently. On receipt, a consumer that understands `hookInput` idempotently
 * ensures the `hook_received` event exists — keyed by `resumeId` — before
 * replaying, so the two concurrent writes converge on exactly one event.
 *
 * The `payload` is the already-serialized (and possibly encrypted) resume
 * payload — the identical bytes the producer also sent on the direct
 * `events.create`, so both server receipts hash to the same digest under the
 * `(runId, resumeId)` constraint.
 */
/**
 * Resilient step dispatch data carried through the queue alongside a
 * step-execution message ({@link WorkflowInvokePayload.stepId}). Present when
 * the producer (the suspension handler dispatching a newly created step)
 * parallelized the `step_created` event write with the queue publish — the
 * same shape as resilient start (`runInput`) and the resilient hook resume
 * (`hookInput`).
 *
 * When the producer's `step_created` write fails transiently (429 / 5xx /
 * transport), the step entity may not exist when this message is consumed. A
 * consumer that understands `stepInput` idempotently re-ensures the
 * `step_created` event — keyed by the message's `stepId` (the step's
 * correlation id, unique per `(runId, correlationId)`) — before executing, so
 * the producer's write and the consumer's re-ensure converge on exactly one
 * event.
 *
 * The `input` is the already-serialized (and possibly encrypted) step input —
 * the identical bytes the producer also sent on the direct `events.create`.
 */
export const StepDispatchInputSchema = z.object({
  /**
   * The serialized step input, reused verbatim from the direct write. Always
   * binary: producers only attach `stepInput` when the dehydrated input is a
   * `Uint8Array` and the run's queue transport preserves bytes (CBOR).
   * Validated here so a malformed or transport-mangled payload fails the
   * message parse instead of being silently written into a `step_created` as
   * non-binary data. `Buffer` is a `Uint8Array` subclass and passes.
   */
  input: z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
    message: 'stepInput.input must be a Uint8Array',
  }),
});
export type StepDispatchInput = z.infer<typeof StepDispatchInputSchema>;

/**
 * Immutable run identity carried on a step-execution message so the consumer
 * can start the step without a blocking `runs.get` round trip. Every field is
 * fixed for the life of a run (runs are pinned to their deployment), and the
 * producer holds the run row at dispatch time, so the copy can never go
 * stale. Run *status* is deliberately NOT carried: liveness is enforced by
 * the `step_started` claim itself, which the World rejects on a terminal run.
 *
 * Consumers that need the full run row (the last completer's inline replay)
 * still fetch it lazily; messages without this field (older producers) take
 * the legacy `runs.get` prologue. Messages are consumed by the deployment
 * that produced them, so mixed handling within one run cannot occur.
 */
export const RunDispatchContextSchema = z.object({
  /** The deployment the run is pinned to (`WorkflowRun.deploymentId`). */
  deploymentId: z.string(),
  /** The run's spec version (`WorkflowRun.specVersion`). */
  specVersion: z.number(),
  /** The run's start time as epoch ms (`WorkflowRun.startedAt`). Numeric so
   *  it survives both queue transports without Date revival concerns. */
  startedAt: z.number().optional(),
  /** The run's lineage root (its `$rootRunId` attribute, or its own id). */
  rootRunId: z.string().optional(),
});
export type RunDispatchContext = z.infer<typeof RunDispatchContextSchema>;

export const HookResumeInputSchema = z.object({
  /** Stable idempotency key minted once per `resumeHook()` call. */
  resumeId: z.string(),
  /** The hook being resumed. */
  hookId: z.string(),
  /**
   * The hook's token, written into the `hook_received` event's `eventData` so
   * the consumer's re-ensured event carries the same token the producer would
   * — replay validates `eventData.token` against the `createHook` token.
   */
  token: z.string(),
  /** The serialized resume payload, reused verbatim from the direct write. */
  payload: z.unknown(),
  /**
   * Content digest of `payload`, computed once by the producer over the
   * serialized bytes and forwarded verbatim on both the direct `events.create`
   * and this queue message. The consumer forwards it back to the server so both
   * writers of the same `resumeId` record an identical digest on the
   * `(runId, resumeId)` constraint — required because the v4 payload ref is not
   * content-stable server-side.
   */
  payloadDigest: z.string(),
  /**
   * The deployment the run is pinned to, from the producer's resume context.
   * Lets the consumer detect a misrouted delivery with a cheap ambient
   * deployment-id comparison BEFORE its hoisted `hook_received` replay-preload
   * write — only a detected mismatch pays for the authoritative run fetch and
   * the deployment-affinity guard. Optional for queued-message compatibility:
   * messages from older producers omit it and simply skip the pre-write
   * check (the authoritative guard before replay still protects them).
   */
  deploymentId: z.string().optional(),
});
export type HookResumeInput = z.infer<typeof HookResumeInputSchema>;

export const WorkflowInvokePayloadSchema = z.object({
  runId: z.string(),
  traceCarrier: TraceCarrierSchema.optional(),
  requestedAt: z.coerce.date().optional(),
  /** Consecutive replay divergences in this recovery chain and latest position. */
  replayDivergence: z
    .object({
      eventId: z.string(),
      count: z.number().int().positive(),
    })
    .optional(),
  /**
   * Re-invocations so far in this chain of stale-snapshot (precondition)
   * rejections. Counted on the message because the in-process restart budget
   * lives in the invocation closure and the queue's delivery count resets on
   * every fresh enqueue, so without this a permanently fenced run would cycle
   * forever instead of failing.
   */
  preconditionReinvocations: z.number().int().positive().optional(),
  /** Number of times this message has been re-enqueued due to server errors (5xx) */
  serverErrorRetryCount: z.number().int().optional(),
  /** Number of times this message has been re-routed after a deployment mismatch */
  deploymentMismatchRetryCount: z.number().int().nonnegative().optional(),
  /** Step ID for inline step execution in combined handler. If provided, the flow execution
   * will jump directly to execute the step with the given ID before doing an event replay. */
  stepId: z.string().optional(),
  /** Step name, sent alongside stepId to avoid loading the event log just to resolve the name. */
  stepName: z.string().optional(),
  /** Run creation data, only present on the first queue delivery from start() */
  runInput: RunInputSchema.optional(),
  /**
   * Lazy hook resume data, only present when `resumeHook()` takes the parallel
   * fast path. A consumer that understands this field idempotently ensures the
   * `hook_received` event exists (keyed by `resumeId`) before replaying.
   */
  hookInput: HookResumeInputSchema.optional(),
  /**
   * Resilient step dispatch data, only present alongside `stepId` when the
   * producer parallelized the `step_created` write with this queue publish. A
   * consumer that understands this field idempotently ensures the
   * `step_created` event exists (keyed by `stepId`) before executing the step.
   */
  stepInput: StepDispatchInputSchema.optional(),
  /**
   * Immutable run identity for step-execution messages (`stepId` present) —
   * lets the consumer skip the blocking `runs.get` before starting the step.
   * See {@link RunDispatchContextSchema}.
   */
  runContext: RunDispatchContextSchema.optional(),
});

export type WorkflowInvokePayload = z.infer<typeof WorkflowInvokePayloadSchema>;
export type HealthCheckPayload = z.infer<typeof HealthCheckPayloadSchema>;

/**
 * Health check payload - used to verify that the queue pipeline
 * can deliver messages to the combined workflow endpoint.
 */
export const HealthCheckPayloadSchema = z.object({
  __healthCheck: z.literal(true),
  correlationId: z.string(),
  /**
   * The run id the caller is about to create, when the probe is being used to
   * prepare a cross-deployment `start()`.
   *
   * The responder runs inside the target deployment, so it can derive that
   * run's public key locally from its own key material and return it in the
   * probe response. That lets the caller seal the workflow arguments without
   * a separate key lookup. Absent for probes issued for other reasons (CLI
   * health command, dashboard), in which case no key is returned.
   */
  runId: z.string().optional(),
});

/**
 * Health check MUST come first.
 *
 * Zod unions return the first matching member's output, and `z.object` strips
 * keys the matching member doesn't declare. `HealthCheckPayloadSchema` carries
 * an optional `runId`, so a probe payload also satisfies
 * `WorkflowInvokePayloadSchema` (whose only required field is `runId`). With
 * the invoke member first, parsing a runId-bearing probe silently dropped
 * `__healthCheck` and `correlationId`, and the runtime — which dispatches on
 * `__healthCheck` before falling through to the invoke schema — reinterpreted
 * the probe as "replay this run". That made the queue handler POST
 * `run_started` for a run that doesn't exist yet (404), fail, and retry
 * forever, so the probe never answered and `start()` timed out.
 *
 * Ordering health check first is safe in the other direction: it requires
 * `__healthCheck: true`, which an invoke payload never carries.
 */
export const QueuePayloadSchema = z.union([
  HealthCheckPayloadSchema,
  WorkflowInvokePayloadSchema,
]);
export type QueuePayload = z.infer<typeof QueuePayloadSchema>;

export interface QueueOptions {
  deploymentId?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  /** Delay message delivery by this many seconds */
  delaySeconds?: number;
  /** Spec version of the target run. Used to select the queue transport format. */
  specVersion?: number;
  /**
   * World-specific routing hint identifying the region the message should
   * be sent to (e.g. a Vercel compute region code such as `'iad1'`).
   *
   * Worlds that don't have a regional dimension ignore this field. For
   * `@workflow/world-vercel`, this overrides the region the underlying
   * `@vercel/queue` client uses to route the message; when omitted, the
   * region is resolved from the payload's tagged run ID, then from the
   * `VERCEL_REGION` environment variable, and finally defaults to `'iad1'`
   * (the pre-regional-routing behaviour).
   */
  region?: string;
}

export interface Queue {
  getDeploymentId(): Promise<string>;

  /**
   * Returns true only when a queue error definitively means the explicitly
   * targeted deployment cannot receive the message. Unknown and transient
   * errors must return false so the current delivery can be retried safely.
   */
  isDeploymentUnavailableError?(error: unknown): boolean;

  /**
   * Enqueues a message to the specified queue.
   *
   * @param queueName - The name of the queue to which the message will be sent.
   * @param message - The content of the message to be sent to the queue.
   * @param opts - Optional parameters for the queue operation.
   */
  queue(
    queueName: ValidQueueName,
    message: QueuePayload,
    opts?: QueueOptions
  ): Promise<{ messageId: MessageId | null }>;

  /**
   * Creates an HTTP queue handler for processing messages from a specific queue.
   * A rejected handler must retry the same message with an incremented attempt.
   *
   * `meta.messageId` SHOULD be stable across redeliveries of the same message
   * (one ID per enqueued message, reused on every delivery attempt). The
   * runtime's inline step ownership uses it as a liveness lease: the lazy
   * `step_started` records the handling invocation's messageId, and only a
   * delivery of that same message may re-execute the step before the
   * ownership lease expires (crash recovery via queue redelivery). A World
   * whose queue mints a fresh ID per delivery degrades gracefully — owner
   * redeliveries fall back to the delayed-backstop path instead of executing
   * immediately, adding recovery latency but never wedging or duplicating.
   */
  createQueueHandler(
    queueNamePrefix: QueuePrefix,
    handler: (
      message: unknown,
      meta: {
        attempt: number;
        queueName: ValidQueueName;
        messageId: MessageId;
        requestId?: string;
      }
      // biome-ignore lint/suspicious/noConfusingVoidType: it is what it is
    ) => Promise<void | { timeoutSeconds: number }>
  ): (req: Request) => Promise<Response>;
}
