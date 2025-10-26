import { z } from 'zod';
import type { SerializedData } from './serialization.js';
import type { PaginationOptions, ResolveData } from './shared.js';

// Workflow run schemas
export const WorkflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'paused',
  'cancelled',
]);

export const WorkflowRunSchema = z.object({
  runId: z.string(),
  deploymentId: z.string(),
  status: WorkflowRunStatusSchema,
  workflowName: z.string(),
  executionContext: z.record(z.string(), z.any()).optional(),
  input: z.array(z.any()),
  output: z.any().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  startedAt: z.coerce.date().optional(),
  completedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// Inferred types
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// Request types
export interface CreateWorkflowRunRequest {
  runId?: string;
  deploymentId: string;
  workflowName: string;
  input: SerializedData[];
  executionContext?: SerializedData;
}

export interface UpdateWorkflowRunRequest {
  status?: WorkflowRunStatus;
  output?: SerializedData;
  error?: string;
  errorCode?: string;
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

export interface PauseWorkflowRunParams {
  resolveData?: ResolveData;
}

export interface ResumeWorkflowRunParams {
  resolveData?: ResolveData;
}
