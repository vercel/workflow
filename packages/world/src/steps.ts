import { z } from 'zod';
import type { SerializedData } from './serialization.js';
import type { PaginationOptions, ResolveData } from './shared.js';

// Step schemas
export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const StepSchema = z.object({
  runId: z.string(),
  stepId: z.string(),
  stepName: z.string(),
  status: StepStatusSchema,
  input: z.array(z.any()),
  output: z.any().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  attempt: z.number(),
  startedAt: z.coerce.date().optional(),
  completedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  retryAfter: z.coerce.date().optional(),
});

// Inferred types
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type Step = z.infer<typeof StepSchema>;

// Request types
export interface CreateStepRequest {
  stepId: string;
  stepName: string;
  input: SerializedData[];
}

export interface UpdateStepRequest {
  attempt?: number;
  status?: StepStatus;
  output?: SerializedData;
  error?: string;
  errorCode?: string;
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
