import { z } from 'zod';
import { type SerializedData, SerializedDataSchema } from './serialization.js';
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

/**
 * Schema for workflow steps.
 *
 * Note: input/output use SerializedDataSchema to support both:
 * - specVersion >= 2: Uint8Array (binary devalue format)
 * - specVersion 1: any (legacy JSON format)
 */
// TODO: implement a discriminated union here just like the run schema
export const StepSchema = z.object({
  runId: z.string(),
  stepId: z.string(),
  /**
   * The machine-readable name of the step function.
   *
   * This field contains a structured identifier like `step//./src/workflows/order//processPayment`
   * that encodes the step's module specifier and function name.
   *
   * Use `parseStepName()` from `@workflow/utils/parse-name` to extract:
   * - `shortName`: User-friendly display name (e.g., `"processPayment"`)
   * - `moduleSpecifier`: The module path or package (e.g., `"./src/workflows/order"`)
   * - `functionName`: The full function path (e.g., `"processPayment"` or `"outer/nested"`)
   *
   * @example
   * ```ts
   * import { parseStepName } from "@workflow/utils/parse-name";
   *
   * const parsed = parseStepName(step.stepName);
   * // parsed.shortName → "processPayment"
   * // parsed.moduleSpecifier → "./src/workflows/order"
   * ```
   */
  stepName: z.string(),
  status: StepStatusSchema,
  input: SerializedDataSchema,
  output: SerializedDataSchema.optional(),
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
  // Optional in database for backwards compatibility, defaults to 1 (legacy) when reading
  specVersion: z.number().optional(),
});

// Inferred types
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type Step = z.infer<typeof StepSchema>;

/**
 * Step with input/output fields excluded (when resolveData='none').
 * Used for listing steps without fetching the full serialized data.
 */
export type StepWithoutData = Omit<Step, 'input' | 'output'> & {
  input: undefined;
  output: undefined;
};

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
