import { z } from 'zod';
import type { SerializedData } from './serialization.js';
import {
  type PaginationOptions,
  type ResolveData,
  type StructuredError,
  StructuredErrorSchema,
} from './shared.js';

// Step schemas
export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

// TODO: implement a discriminated union here just like the run schema
export const StepSchema = z.object({
  runId: z.string(),
  stepId: z.string(),
  stepName: z.string(),
  status: StepStatusSchema,
  input: z.array(z.any()),
  output: z.any().optional(),
  /**
   * The error from a step_retrying or step_failed event.
   * This tracks the most recent error the step encountered, which may
   * be from a retry attempt (step_retrying) or the final failure (step_failed).
   */
  error: StructuredErrorSchema.optional(),
  attempt: z.number(),
  /**
   * When the step first started executing. Set by the first step_started event
   * and not updated on subsequent retries.
   */
  startedAt: z.coerce.date().optional(),
  completedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  retryAfter: z.coerce.date().optional(),
  specVersion: z.number().optional(),
});

// Inferred types
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type Step = z.infer<typeof StepSchema>;

// Request types
export interface CreateStepRequest {
  stepId: string;
  stepName: string;
  input: SerializedData;
}

export interface UpdateStepRequest {
  attempt?: number;
  status?: StepStatus;
  output?: SerializedData;
  error?: StructuredError;
  retryAfter?: Date;
}

export interface GetStepParams {
  resolveData?: ResolveData;
}

export interface ListWorkflowRunStepsParams {
  runId: string;
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}
