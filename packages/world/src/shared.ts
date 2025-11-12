import { z } from 'zod';

export const zodJsonSchema: z.ZodType<unknown> = z.lazy(() => {
  return z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(zodJsonSchema),
    z.record(z.string(), zodJsonSchema),
  ]);
});

/**
 * Options for paginated queries.
 * Provides control over page size and cursor-based navigation.
 */
export interface PaginationOptions {
  /** Maximum number of items to return (default varies by service, max: 1000) */
  limit?: number;
  /** Cursor for pagination - token from previous response */
  cursor?: string;
  // Sorted by creation time, defaults to the world's default for the specific
  // list call. If you know what sort order you want, always specify it.
  sortOrder?: 'asc' | 'desc';
}

// Shared schema for paginated responses
export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(
  dataSchema: T
) =>
  z.object({
    data: z.array(dataSchema),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
  });

// Inferred type from schema
export type PaginatedResponse<T> = z.infer<
  ReturnType<typeof PaginatedResponseSchema<z.ZodType<T>>>
>;

/**
 * Controls how much data is resolved in the response.
 * - "none": Returns minimal data with input: [] and output: undefined
 * - "all": Returns full data with complete input and output
 */
export type ResolveData = 'none' | 'all';

/**
 * A standard error schema shape for propogating errors from runs and steps
 */
export const StructuredErrorSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
  code: z.string().optional(), // TODO: currently unused. make this an enum maybe
});

export type StructuredError = z.infer<typeof StructuredErrorSchema>;
