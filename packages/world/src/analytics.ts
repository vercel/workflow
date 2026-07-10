import { z } from 'zod';
import { EventTypeSchema } from './events.js';
import { WorkflowRunStatusSchema } from './runs.js';
import type { PaginatedResponse, PaginationOptions } from './shared.js';
import { StepStatusSchema } from './steps.js';
import { WaitStatusSchema } from './waits.js';

const NullableDateSchema = z.coerce.date().nullable().optional();
const NullableStringSchema = z.string().nullable().optional();
const NullableBooleanSchema = z.boolean().nullable().optional();

// Keep analytics object schemas standalone even when they mirror storage
// metadata fields. This namespace is an explicit metadata-only read contract;
// payload and secret fields should only appear here through deliberate opt-in.
export const AnalyticsRunSchema = z.object({
  runId: z.string(),
  status: WorkflowRunStatusSchema,
  deploymentId: z.string(),
  workflowName: z.string(),
  specVersion: z.coerce.number().optional(),
  attributes: z.record(z.string(), z.string()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  startedAt: NullableDateSchema,
  completedAt: NullableDateSchema,
  errorCode: NullableStringSchema,
  workflowCoreVersion: NullableStringSchema,
  workflowEncryptionEnabled: NullableBooleanSchema,
});

export const AnalyticsStepSchema = z.object({
  runId: z.string(),
  stepId: z.string(),
  stepName: NullableStringSchema,
  status: StepStatusSchema,
  attempt: z.number().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  startedAt: NullableDateSchema,
  completedAt: NullableDateSchema,
  retryAfter: NullableDateSchema,
  errorCode: NullableStringSchema,
  workflowCoreVersion: NullableStringSchema,
  workflowEncryptionEnabled: NullableBooleanSchema,
});

export const AnalyticsEventSchema = z.object({
  runId: z.string(),
  eventId: z.string(),
  eventType: EventTypeSchema,
  correlationId: NullableStringSchema,
  entityId: NullableStringSchema,
  stepName: NullableStringSchema,
  workflowName: z.string(),
  deploymentId: z.string(),
  specVersion: z.coerce.number().optional(),
  runCreatedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  region: NullableStringSchema,
  vercelId: NullableStringSchema,
  requestId: NullableStringSchema,
  resumeAt: NullableDateSchema,
  retryAfter: NullableDateSchema,
  errorCode: NullableStringSchema,
  workflowCoreVersion: NullableStringSchema,
  isWebhook: NullableBooleanSchema,
  isSystem: NullableBooleanSchema,
  workflowEncryptionEnabled: NullableBooleanSchema,
});

export const AnalyticsHookSchema = z.object({
  runId: z.string(),
  hookId: z.string(),
  status: z.enum(['created', 'received', 'disposed', 'conflict']),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  receivedAt: NullableDateSchema,
  disposedAt: NullableDateSchema,
  isWebhook: NullableBooleanSchema,
  isSystem: NullableBooleanSchema,
  workflowCoreVersion: NullableStringSchema,
  workflowEncryptionEnabled: NullableBooleanSchema,
});

export const AnalyticsWaitSchema = z.object({
  runId: z.string(),
  waitId: z.string(),
  status: WaitStatusSchema,
  resumeAt: NullableDateSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  completedAt: NullableDateSchema,
  workflowCoreVersion: NullableStringSchema,
  workflowEncryptionEnabled: NullableBooleanSchema,
});

export type AnalyticsRun = z.infer<typeof AnalyticsRunSchema>;
export type AnalyticsStep = z.infer<typeof AnalyticsStepSchema>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsHook = z.infer<typeof AnalyticsHookSchema>;
export type AnalyticsWait = z.infer<typeof AnalyticsWaitSchema>;

export interface AnalyticsListRunsParams {
  workflowName?: string;
  status?: AnalyticsRun['status'];
  /**
   * Bound the listing to runs active between `startTime` and `endTime`
   * (ISO 8601 timestamps). Both must be provided together. A bounded window
   * lets the backend prune its scan — the ClickHouse-backed Vercel
   * implementation is significantly faster with one. Requesting a window
   * older than the plan's observability lookback fails with
   * `observability-upgrade-required`.
   */
  startTime?: string;
  endTime?: string;
  pagination?: PaginationOptions;
}

export interface AnalyticsListRunScopedParams {
  runId: string;
  pagination?: PaginationOptions;
}

export interface AnalyticsListEventsParams
  extends AnalyticsListRunScopedParams {
  eventType?: AnalyticsEvent['eventType'];
  correlationId?: string;
}

export interface AnalyticsListEventsByCorrelationIdParams {
  correlationId: string;
  pagination?: PaginationOptions;
}

export interface AnalyticsListHooksParams {
  runId: string;
  pagination?: PaginationOptions;
}

export interface AnalyticsListWaitsParams extends AnalyticsListRunScopedParams {
  status?: AnalyticsWait['status'];
}

export interface Analytics {
  runs: {
    get(runId: string): Promise<AnalyticsRun>;
    list(
      params?: AnalyticsListRunsParams
    ): Promise<PaginatedResponse<AnalyticsRun>>;
  };
  steps: {
    get(runId: string, stepId: string): Promise<AnalyticsStep>;
    list(
      params: AnalyticsListRunScopedParams
    ): Promise<PaginatedResponse<AnalyticsStep>>;
  };
  events: {
    get(runId: string, eventId: string): Promise<AnalyticsEvent>;
    list(
      params: AnalyticsListEventsParams
    ): Promise<PaginatedResponse<AnalyticsEvent>>;
    listByCorrelationId(
      params: AnalyticsListEventsByCorrelationIdParams
    ): Promise<PaginatedResponse<AnalyticsEvent>>;
  };
  hooks: {
    get(hookId: string, params?: { runId?: string }): Promise<AnalyticsHook>;
    list(
      params: AnalyticsListHooksParams
    ): Promise<PaginatedResponse<AnalyticsHook>>;
  };
  waits: {
    get(runId: string, waitId: string): Promise<AnalyticsWait>;
    list(
      params: AnalyticsListWaitsParams
    ): Promise<PaginatedResponse<AnalyticsWait>>;
  };
}
