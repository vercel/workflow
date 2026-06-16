import { z } from 'zod/v4';

export type QueueKind = 'workflow' | 'step';

/**
 * Pattern matching valid queue prefixes:
 * - `__wkf_workflow_` / `__wkf_step_` (default, no namespace)
 * - `__{namespace}_wkf_workflow_` / `__{namespace}_wkf_step_` (namespaced)
 *
 * Namespace must be lowercase alphanumeric starting with a letter.
 */
export const QueuePrefix = z
  .string()
  .regex(
    /^__(?:[a-z][a-z0-9]*_)?wkf_(?:workflow|step)_$/,
    'Must match __wkf_{workflow|step}_ or __{namespace}_wkf_{workflow|step}_'
  );
export type QueuePrefix = z.infer<typeof QueuePrefix>;

export const ValidQueueName = z
  .string()
  .regex(
    /^__(?:[a-z][a-z0-9]*_)?wkf_(?:workflow|step)_.+$/,
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
 * Builds a queue topic prefix for the given kind and optional namespace.
 *
 * - `getQueueTopicPrefix('workflow')` → `'__wkf_workflow_'`
 * - `getQueueTopicPrefix('workflow', 'custom')` → `'__custom_wkf_workflow_'`
 */
export function getQueueTopicPrefix(
  kind: QueueKind,
  namespace?: string
): QueuePrefix {
  if (namespace !== undefined) {
    QueueNamespace.parse(namespace);
    return `__${namespace}_wkf_${kind}_` as QueuePrefix;
  }
  return `__wkf_${kind}_` as QueuePrefix;
}

export function getQueuePrefixKind(prefix: QueuePrefix): QueueKind {
  const match = QueuePrefix.parse(prefix).match(
    /^__(?:[a-z][a-z0-9]*_)?wkf_(workflow|step)_$/
  );

  if (!match) {
    throw new Error(`Invalid queue prefix: ${prefix}`);
  }

  return match[1] as QueueKind;
}

export function parseQueueName(name: ValidQueueName): {
  prefix: QueuePrefix;
  kind: QueueKind;
  id: string;
} {
  const match = name.match(
    /^(__(?:[a-z][a-z0-9]*_)?wkf_(workflow|step)_)(.+)$/
  );

  if (!match) {
    throw new Error(`Invalid queue name: ${name}`);
  }

  return {
    prefix: QueuePrefix.parse(match[1]),
    kind: match[2] as QueueKind,
    id: match[3],
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
});
export type RunInput = z.infer<typeof RunInputSchema>;

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
  /** Number of times this message has been re-enqueued due to server errors (5xx) */
  serverErrorRetryCount: z.number().int().optional(),
  /** Step ID for inline step execution in combined handler. If provided, the flow execution
   * will jump directly to execute the step with the given ID before doing an event replay. */
  stepId: z.string().optional(),
  /** Step name, sent alongside stepId to avoid loading the event log just to resolve the name. */
  stepName: z.string().optional(),
  /** Run creation data, only present on the first queue delivery from start() */
  runInput: RunInputSchema.optional(),
});

export const StepInvokePayloadSchema = z.object({
  workflowName: z.string(),
  workflowRunId: z.string(),
  workflowStartedAt: z.number(),
  stepId: z.string(),
  traceCarrier: TraceCarrierSchema.optional(),
  requestedAt: z.coerce.date().optional(),
});

export type WorkflowInvokePayload = z.infer<typeof WorkflowInvokePayloadSchema>;
export type StepInvokePayload = z.infer<typeof StepInvokePayloadSchema>;
export type HealthCheckPayload = z.infer<typeof HealthCheckPayloadSchema>;

/**
 * Health check payload - used to verify that the queue pipeline
 * can deliver messages to workflow/step endpoints.
 */
export const HealthCheckPayloadSchema = z.object({
  __healthCheck: z.literal(true),
  correlationId: z.string(),
});

export const QueuePayloadSchema = z.union([
  WorkflowInvokePayloadSchema,
  StepInvokePayloadSchema,
  HealthCheckPayloadSchema,
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
}

export interface Queue {
  getDeploymentId(): Promise<string>;

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
