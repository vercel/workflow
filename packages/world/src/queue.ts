import { z } from 'zod/v4';

export const QueuePrefix = z.union([
  z.literal('__wkf_step_'),
  z.literal('__wkf_workflow_'),
]);
export type QueuePrefix = z.infer<typeof QueuePrefix>;

export const ValidQueueName = z.templateLiteral([QueuePrefix, z.string()]);
export type ValidQueueName = z.infer<typeof ValidQueueName>;

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
});
export type RunInput = z.infer<typeof RunInputSchema>;

/**
 * Hook resume data carried through the queue for resilient resumeHook().
 * Only present on the queue delivery triggered by resumeHook() — re-enqueues
 * omit this. When the runtime processes the message and detects that the
 * corresponding hook_received event is missing (e.g., because events.create()
 * failed with a transient 429/5xx while queue() succeeded), it materializes
 * the hook_received event from this payload.
 *
 * `resumeId` is a client-minted ULID used as an idempotency key: both the
 * direct hook_received write (from resumeHook) and the runtime fallback write
 * include it in `eventData.resumeId`, so the runtime can dedup by checking
 * whether any existing hook_received event already carries the same resumeId.
 */
export const HookInputSchema = z.object({
  /** correlationId of the target hook (hookId) */
  hookId: z.string(),
  /** Client-minted ULID; idempotency key shared across both write paths */
  resumeId: z.string(),
  /**
   * The hook's token, written into the materialized event's
   * `eventData.token` so it gets the same replay-divergence guard as a
   * directly written hook_received event. Optional for wire compatibility.
   */
  token: z.string().optional(),
  /** Dehydrated payload to deliver to the hook */
  payload: z.unknown(),
});
export type HookInput = z.infer<typeof HookInputSchema>;

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
  /** Hook resume data, only present on the queue delivery from resumeHook() */
  hookInput: HookInputSchema.optional(),
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
