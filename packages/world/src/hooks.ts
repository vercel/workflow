import { z } from 'zod';
import { TraceCarrierSchema } from './queue.js';
import type { SerializedData } from './serialization.js';
import { SerializedDataSchema } from './serialization.js';
import type { PaginationOptions, ResolveData } from './shared.js';

/**
 * Minimal, immutable slice of a hook's owning run needed to resume it —
 * enough for encryption-key resolution, serialization/compression capability
 * selection, queue routing, and trace linking, without fetching the full run.
 *
 * Persisted on new hook records (workflow-server) and also returned inline by
 * `getByToken`, so a resume can skip the separate `runs.get`. Deliberately
 * excludes the run's mutable state (e.g. status), inputs/outputs, attributes,
 * and any secret — only fields that are fixed at hook-creation time.
 */
export const HookResumeContextSchema = z.object({
  deploymentId: z.string(),
  workflowName: z.string(),
  // Named `runSpecVersion` to distinguish it from the hook's own `specVersion`.
  runSpecVersion: z.number().optional(),
  workflowCoreVersion: z.string().optional(),
  traceCarrier: TraceCarrierSchema.optional(),
  // The run's published X25519 public key (base64), mirrored from the run
  // entity. Lets a resume seal (`encp`) its payload to the run without reading
  // the run or fetching its symmetric key. Absent on runs created before
  // sealed envelopes and on projects with encryption disabled, where the
  // resume falls back to the symmetric per-run key.
  encryptionPublicKey: z.string().optional(),
});

export type HookResumeContext = z.infer<typeof HookResumeContextSchema>;

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
  // Present when the server stored it (new hooks) or synthesized it from the
  // run (old hooks). Absent only against an old server, where the resume path
  // falls back to `runs.get`.
  resumeContext: HookResumeContextSchema.optional(),
});

/**
 * Represents a Hook. Hooks kept by minimum retention remain readable after
 * their workflow runs end, but cannot be resumed.
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
