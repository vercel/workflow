import { z } from 'zod';

const WorkflowObservabilityEventMetaSchema = z
  .object({
    at: z.string().optional(),
  })
  .passthrough();

export const WorkflowObservabilityEventSchema = z
  .object({
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
    meta: WorkflowObservabilityEventMetaSchema.optional(),
  })
  .passthrough();

export type WorkflowObservabilityEvent = z.infer<
  typeof WorkflowObservabilityEventSchema
>;

export const WorkflowObservabilityEventWriterSchema = z.object({
  type: z.literal('step'),
  stepId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
});

export type WorkflowObservabilityEventWriter = z.infer<
  typeof WorkflowObservabilityEventWriterSchema
>;

export const ReportWorkflowObservabilityEventRequestSchema = z.object({
  event: WorkflowObservabilityEventSchema,
  writer: WorkflowObservabilityEventWriterSchema.optional(),
});

export type ReportWorkflowObservabilityEventRequest = z.infer<
  typeof ReportWorkflowObservabilityEventRequestSchema
>;

export const ReportWorkflowObservabilityEventResponseSchema = z.object({
  ok: z.literal(true),
});

export type ReportWorkflowObservabilityEventResponse = z.infer<
  typeof ReportWorkflowObservabilityEventResponseSchema
>;
