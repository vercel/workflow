import { z } from 'zod';
import { type SerializedData, SerializedDataSchema } from './serialization.js';
import {
  type PaginationOptions,
  type ResolveData,
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
 * which implements a discriminatedUnion for various states.
 *
 * Note: input/output use SerializedDataSchema to support both:
 * - specVersion >= 2: Uint8Array (binary devalue format)
 * - specVersion 1: any (legacy JSON format)
 */
export const WorkflowRunBaseSchema = z.object({
  runId: z.string(),
  status: WorkflowRunStatusSchema,
  deploymentId: z.string(),
  workflowName: z.string(),
  // Optional in database for backwards compatibility, defaults to 1 (legacy) when reading
  specVersion: z.number().optional(),
  executionContext: z.record(z.string(), z.any()).optional(),
  input: SerializedDataSchema,
  output: SerializedDataSchema.optional(),
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
  // Completed state - output can be v1 or v2 format
  WorkflowRunBaseSchema.extend({
    status: z.literal('completed'),
    output: SerializedDataSchema,
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

/**
 * WorkflowRun with input/output fields excluded (when resolveData='none').
 * Used for listing runs without fetching the full serialized data.
 */
export type WorkflowRunWithoutData = Omit<WorkflowRun, 'input' | 'output'> & {
  input: undefined;
  output: undefined;
};

// Request types
export interface CreateWorkflowRunRequest {
  deploymentId: string;
  workflowName: string;
  input: SerializedData;
  executionContext?: SerializedData;
  specVersion?: number;
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
