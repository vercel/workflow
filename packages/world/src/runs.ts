import { z } from 'zod';
import { type SerializedData, SerializedDataSchema } from './serialization.js';
import type { PaginationOptions, ResolveData } from './shared.js';

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
  /**
   * The machine-readable name of the workflow function.
   *
   * This field contains a structured identifier like `workflow//./src/workflows/order//processOrder`
   * that encodes the workflow's module specifier and function name.
   *
   * Use `parseWorkflowName()` from `@workflow/utils/parse-name` to extract:
   * - `shortName`: User-friendly display name (e.g., `"processOrder"`)
   * - `moduleSpecifier`: The module path or package (e.g., `"./src/workflows/order"`)
   * - `functionName`: The full function path (e.g., `"processOrder"`)
   *
   * @example
   * ```ts
   * import { parseWorkflowName } from "@workflow/utils/parse-name";
   *
   * const parsed = parseWorkflowName(run.workflowName);
   * // parsed.shortName → "processOrder"
   * // parsed.moduleSpecifier → "./src/workflows/order"
   * ```
   */
  workflowName: z.string(),
  // Optional in database for backwards compatibility, defaults to 1 (legacy) when reading
  specVersion: z.number().optional(),
  executionContext: z.record(z.string(), z.any()).optional(),
  input: SerializedDataSchema.optional(),
  output: SerializedDataSchema.optional(),
  /**
   * The thrown value from a run_failed event, serialized via the workflow
   * serialization pipeline. To display the error to a user, hydrate it via
   * `hydrateRunError` (with the encryption key if encryption is enabled).
   * Observability tools cannot view the error without going through the
   * decryption + hydration pipeline.
   */
  error: SerializedDataSchema.optional(),
  /**
   * The high-level error category (USER_ERROR, RUNTIME_ERROR, etc.) from a
   * run_failed event. Kept as plaintext metadata for routing and filtering
   * without needing to decrypt the full error payload.
   */
  errorCode: z.string().optional(),
  /**
   * Plaintext string-string metadata attached to the run via
   * `experimental_setAttributes()` (or, in the future, materialized
   * from `attr_set` events). Stored unencrypted alongside other
   * plaintext fields so observability surfaces can read it without
   * going through the decryption pipeline.
   *
   * Defaults to `{}` after schema parsing so consumers always receive
   * a record regardless of world. World adapters need not initialize
   * the field on disk — `world-local` JSON files written before this
   * field existed, and rows from any other adapter that omits the
   * column, both read as `{}` after Zod parses them.
   *
   * EXPERIMENTAL (MVP): the full Workflow Attributes feature replaces
   * the direct-mutation MVP path with an event-sourced model — see
   * the attributes-mvp changelog entry.
   */
  attributes: z.record(z.string(), z.string()).default({}),
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
    output: z.undefined().optional(),
    error: z.undefined().optional(),
    completedAt: z.undefined().optional(),
  }),
  // Cancelled state
  WorkflowRunBaseSchema.extend({
    status: z.literal('cancelled'),
    output: z.undefined().optional(),
    error: z.undefined().optional(),
    completedAt: z.coerce.date(),
  }),
  // Completed state - output can be v1 or v2 format
  WorkflowRunBaseSchema.extend({
    status: z.literal('completed'),
    output: SerializedDataSchema,
    error: z.undefined().optional(),
    completedAt: z.coerce.date(),
  }),
  // Failed state
  WorkflowRunBaseSchema.extend({
    status: z.literal('failed'),
    output: z.undefined().optional(),
    error: SerializedDataSchema,
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
