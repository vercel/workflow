import { z } from 'zod';

const WorkflowExecutionErrorOccurrenceMetaSchema = z
  .object({
    at: z.string().optional(),
  })
  .passthrough();

export const WorkflowExecutionErrorOccurrenceSchema = z
  .object({
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
    meta: WorkflowExecutionErrorOccurrenceMetaSchema.optional(),
  })
  .passthrough();

export type WorkflowExecutionErrorOccurrence = z.infer<
  typeof WorkflowExecutionErrorOccurrenceSchema
>;

export const WorkflowExecutionErrorOccurrenceWriterSchema = z.object({
  type: z.literal('step'),
  stepId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
});

export type WorkflowExecutionErrorOccurrenceWriter = z.infer<
  typeof WorkflowExecutionErrorOccurrenceWriterSchema
>;

export const ReportWorkflowExecutionErrorOccurrenceRequestSchema = z.object({
  event: WorkflowExecutionErrorOccurrenceSchema,
  writer: WorkflowExecutionErrorOccurrenceWriterSchema.optional(),
});

export type ReportWorkflowExecutionErrorOccurrenceRequest = z.infer<
  typeof ReportWorkflowExecutionErrorOccurrenceRequestSchema
>;

export const ReportWorkflowExecutionErrorOccurrenceResponseSchema = z.object({
  ok: z.literal(true),
});

export type ReportWorkflowExecutionErrorOccurrenceResponse = z.infer<
  typeof ReportWorkflowExecutionErrorOccurrenceResponseSchema
>;
