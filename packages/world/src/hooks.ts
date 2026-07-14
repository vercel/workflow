import { z } from 'zod';
import type { SerializedData } from './serialization.js';
import { SerializedDataSchema } from './serialization.js';
import type { PaginationOptions, ResolveData } from './shared.js';

/**
 * Schema for workflow hooks.
 *
 * Note: metadata uses SerializedDataSchema to support both:
 * - specVersion >= 2: Uint8Array (binary devalue format)
 * - specVersion 1: any (legacy JSON format)
 */
// Hook schemas
export const HookSchema = z.object({
  runId: z.string(),
  hookId: z.string(),
  token: z.string(),
  ownerId: z.string(),
  projectId: z.string(),
  environment: z.string(),
  metadata: SerializedDataSchema.optional(),
  createdAt: z.coerce.date(),
  // Optional in database for backwards compatibility, defaults to 1 (legacy) when reading
  specVersion: z.number().optional(),
  isWebhook: z.boolean().optional(),
  isSystem: z.boolean().optional(),
});

/**
 * Represents a hook that can be used to resume a paused workflow run.
 *
 * Note: metadata type is SerializedData to support both:
 * - specVersion >= 2: Uint8Array (binary devalue format)
 * - specVersion 1: unknown (legacy JSON format)
 */
export type Hook = z.infer<typeof HookSchema>;

// Request types
export interface CreateHookRequest {
  hookId: string;
  token: string;
  metadata?: SerializedData;
  isWebhook?: boolean;
}

export interface GetHookByTokenParams {
  token: string;
}

export interface ListHooksParams {
  runId?: string;
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}

export interface GetHookParams {
  resolveData?: ResolveData;
}
