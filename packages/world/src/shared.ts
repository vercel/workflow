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
  code: z.string().optional(), // Populated with RunErrorCode values (USER_ERROR, RUNTIME_ERROR) for run_failed events
});

export type StructuredError = z.infer<typeof StructuredErrorSchema>;

/**
 * A single chunk from a stream, with its 0-based index and raw binary data.
 */
export interface StreamChunk {
  /** The 0-based position of this chunk in the stream */
  index: number;
  /** The raw chunk data */
  data: Uint8Array;
}

/**
 * Options for paginated chunk retrieval.
 */
export interface GetChunksOptions {
  /** Maximum number of chunks to return per page (default: 100, max: 1000) */
  limit?: number;
  /** Opaque cursor from a previous response to fetch the next page */
  cursor?: string;
}

/**
 * Metadata about a stream, returned by {@link Streamer.getStreamInfo}.
 */
export interface StreamInfoResponse {
  /**
   * The index of the last known chunk (0-based).
   * Returns `-1` when no chunks have been written yet.
   */
  tailIndex: number;
  /** Whether the stream is fully complete (closed). */
  done: boolean;
}

/**
 * Paginated response for stream chunks.
 *
 * Extends the standard `PaginatedResponse` shape with a `done` field that
 * indicates whether the stream has been fully written (closed). When `done`
 * is `false`, additional chunks may appear in future requests even after
 * `hasMore` returns `false` for the current set of available chunks.
 */
export interface StreamChunksResponse {
  /** Array of stream chunks in index order */
  data: StreamChunk[];
  /** Cursor for the next page, or `null` when no more pages are available */
  cursor: string | null;
  /** Whether additional pages of already-written chunks exist */
  hasMore: boolean;
  /** Whether the stream is fully complete (all chunks have been written and the stream is closed) */
  done: boolean;
}
