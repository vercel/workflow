import { z } from 'zod';
import type { SerializedData } from './serialization.js';
import {
  type PaginationOptions,
  type ResolveData,
  type StructuredError,
  StructuredErrorSchema,
} from './shared.js';

// Workflow run schemas
export const WorkflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Base schema for the Workflow runs. Prefer using WorkflowRunSchema
 * which implements a discriminatedUnion for various states
 */
export const WorkflowRunBaseSchema = z.object({
  runId: z.string(),
  status: WorkflowRunStatusSchema,
  deploymentId: z.string(),
  workflowName: z.string(),
  executionContext: z.record(z.string(), z.any()).optional(),
  input: z.array(z.any()),
  output: z.any().optional(),
  error: StructuredErrorSchema.optional(),
  expiredAt: z.coerce.date().optional(),
  startedAt: z.coerce.date().optional(),
  completedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// Discriminated union based on status
export const WorkflowRunSchema = z.discriminatedUnion('status', [
  // Non-final states
  WorkflowRunBaseSchema.extend({
    status: z.enum(['pending', 'running']),
    output: z.undefined(),
    error: z.undefined(),
    completedAt: z.undefined(),
  }),
  // Cancelled state
  WorkflowRunBaseSchema.extend({
    status: z.literal('cancelled'),
    output: z.undefined(),
    error: z.undefined(),
    completedAt: z.coerce.date(),
  }),
  // Completed state
  WorkflowRunBaseSchema.extend({
    status: z.literal('completed'),
    output: z.any(),
    error: z.undefined(),
    completedAt: z.coerce.date(),
  }),
  // Failed state
  WorkflowRunBaseSchema.extend({
    status: z.literal('failed'),
    output: z.undefined(),
    error: StructuredErrorSchema,
    completedAt: z.coerce.date(),
  }),
]);

// Inferred types
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// Request types
export interface CreateWorkflowRunRequest {
  deploymentId: string;
  workflowName: string;
  input: SerializedData[];
  executionContext?: SerializedData;
}

export interface UpdateWorkflowRunRequest {
  status?: WorkflowRunStatus;
  output?: SerializedData;
  error?: StructuredError;
  executionContext?: Record<string, any>;
}

export interface GetWorkflowRunParams {
  resolveData?: ResolveData;
}

export interface ListWorkflowRunsParams {
  workflowName?: string;
  status?: WorkflowRunStatus;
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}

export interface CancelWorkflowRunParams {
  resolveData?: ResolveData;
}
