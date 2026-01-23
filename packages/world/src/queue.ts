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

export const WorkflowInvokePayloadSchema = z.object({
  runId: z.string(),
  traceCarrier: TraceCarrierSchema.optional(),
  requestedAt: z.coerce.date().optional(),
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
  ): Promise<{ messageId: MessageId }>;

  /**
   * Creates an HTTP queue handler for processing messages from a specific queue.
   */
  createQueueHandler(
    queueNamePrefix: QueuePrefix,
    handler: (
      message: unknown,
      meta: { attempt: number; queueName: ValidQueueName; messageId: MessageId }
      // biome-ignore lint/suspicious/noConfusingVoidType: it is what it is
    ) => Promise<void | { timeoutSeconds: number }>
  ): (req: Request) => Promise<Response>;
}
