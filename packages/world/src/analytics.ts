import { z } from 'zod';
import { EventTypeSchema } from './events.js';
import { WorkflowRunStatusSchema } from './runs.js';
import type { PaginatedResponse, PaginationOptions } from './shared.js';
import { StepStatusSchema } from './steps.js';
import { WaitStatusSchema } from './waits.js';

/**
 * Timezone-naive datetime string, e.g. `2026-07-13 17:09:11.593` — the
 * shape ClickHouse-backed analytics endpoints serialize `DateTime64`
 * values as. Such values are UTC by convention but carry no designator.
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Date coercion that parses timezone-naive strings as UTC.
 *
 * `z.coerce.date()` delegates to `new Date(value)`, which interprets a
 * naive string in the **process's local timezone**. That is only correct
 * when the process runs in UTC (e.g. the deployed observability web app's
 * server actions) and is wrong by the local UTC offset everywhere else —
 * the CLI on a laptop, `workflow web --localUi`, tests. Normalizing naive
 * strings to an explicit `Z` designator makes parsing timezone-independent.
 * Values that already carry timezone information (a `Z` or `±hh:mm`
 * offset), and non-string inputs (Date, epoch number), are forwarded
 * without modification before coercion.
 */
const UTCDateSchema = z.preprocess((value) => {
  if (typeof value === 'string' && NAIVE_DATETIME.test(value)) {
    return `${value.replace(' ', 'T')}Z`;
  }
  return value;
}, z.coerce.date());

const NullableDateSchema = UTCDateSchema.nullable().optional();
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
  createdAt: UTCDateSchema,
  updatedAt: UTCDateSchema,
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
  createdAt: UTCDateSchema,
  updatedAt: UTCDateSchema,
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
  runCreatedAt: UTCDateSchema,
  createdAt: UTCDateSchema,
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
  createdAt: UTCDateSchema,
  updatedAt: UTCDateSchema,
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
  createdAt: UTCDateSchema,
  updatedAt: UTCDateSchema,
  completedAt: NullableDateSchema,
  workflowCoreVersion: NullableStringSchema,
  workflowEncryptionEnabled: NullableBooleanSchema,
});

export const AnalyticsAttributeKeySchema = z.object({
  key: z.string(),
  runCount: z.coerce.number(),
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
});

export type AnalyticsRun = z.infer<typeof AnalyticsRunSchema>;
export type AnalyticsStep = z.infer<typeof AnalyticsStepSchema>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsHook = z.infer<typeof AnalyticsHookSchema>;
export type AnalyticsWait = z.infer<typeof AnalyticsWaitSchema>;
export type AnalyticsAttributeKey = z.infer<typeof AnalyticsAttributeKeySchema>;

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
  /**
   * Restrict the listing to runs whose latest attribute snapshot matches
   * every provided key=value pair (up to 8 pairs). Matching is
   * latest-write-wins: a run whose attribute moved from `v1` to `v2` no
   * longer matches `v1`. Reserved `$`-prefixed keys may be used in filters
   * even though user writes to that namespace are rejected.
   */
  attributes?: Record<string, string>;
  pagination?: PaginationOptions;
}

export interface AnalyticsListAttributesParams {
  workflowName?: string;
  /**
   * Bound the listing to attribute writes between `startTime` and `endTime`
   * (ISO 8601 timestamps). Both must be provided together. Requesting a
   * window older than the plan's observability lookback fails with
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
  attributes: {
    /**
     * List the distinct attribute keys observed on runs in the window,
     * with run counts and first/last seen timestamps. Ordered
     * alphabetically by key.
     */
    list(
      params?: AnalyticsListAttributesParams
    ): Promise<PaginatedResponse<AnalyticsAttributeKey>>;
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
