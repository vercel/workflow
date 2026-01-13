import { z } from 'zod';
import type { SerializedData } from './serialization.js';
import {
  type PaginationOptions,
  type ResolveData,
  zodJsonSchema,
} from './shared.js';

// Hook schemas
export const HookSchema = z.object({
  /** The unique identifier of the workflow run this hook belongs to. */
  runId: z.string(),
  /** The unique identifier of this hook within the workflow run. */
  hookId: z.string(),
  /** The secret token used to reference this hook. */
  token: z.string(),
  /** The owner ID (team or user) that owns this hook. */
  ownerId: z.string(),
  /** The project ID this hook belongs to. */
  projectId: z.string(),
  /** The environment (e.g., "production", "preview", "development") where this hook was created. */
  environment: z.string(),
  /** Optional metadata associated with the hook, set when the hook was created. */
  metadata: zodJsonSchema.optional(),
  /** The timestamp when this hook was created. */
  createdAt: z.coerce.date(),
});

/**
 * Represents a hook that can be used to resume a paused workflow run.
 */
export type Hook = {
  /** The unique identifier of the workflow run this hook belongs to. */
  runId: string;
  /** The unique identifier of this hook within the workflow run. */
  hookId: string;
  /** The secret token used to reference this hook. */
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
};

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
