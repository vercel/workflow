import { z } from 'zod';
import type { SerializedData } from './serialization.js';
import {
  type PaginationOptions,
  type ResolveData,
  zodJsonSchema,
} from './shared.js';

/**
 * Represents a hook that can be used to resume a paused workflow run.
 */
export interface Hook {
  /** The unique identifier of the workflow run this hook belongs to. */
  runId: string;
  /** The unique identifier of this hook within the workflow run. */
  hookId: string;
  /** The secret token used to resume this hook. */
  token: string;
  /** The owner ID (team or user) that owns this hook. */
  ownerId: string;
  /** The project ID this hook belongs to. */
  projectId: string;
  /** The environment (e.g., "production", "preview", "development") where this hook was created. */
  environment: string;
  /** Optional metadata associated with the hook, set when the hook was created. */
  metadata?: unknown;
  /** The timestamp when this hook was created. */
  createdAt: Date;
}

// Hook schema for validation
export const HookSchema: z.ZodType<Hook> = z.object({
  runId: z.string(),
  hookId: z.string(),
  token: z.string(),
  ownerId: z.string(),
  projectId: z.string(),
  environment: z.string(),
  metadata: zodJsonSchema.optional(),
  createdAt: z.coerce.date(),
});

// Request types
export interface CreateHookRequest {
  hookId: string;
  token: string;
  metadata?: SerializedData;
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
