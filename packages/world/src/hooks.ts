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
  // Feature marker: the version of the lazy-hook-resume consumer protocol the
  // run's creating deployment supports. Present (>= 1) means that deployment's
  // `@workflow/core` re-ensures the `hook_received` event from the queue
  // message's `hookInput` on replay, so `resumeHook()`'s parallel fast path is
  // safe to use. Because a run is pinned to its creating deployment, this
  // marker is a reliable per-run attestation — unlike inferring support from a
  // version compare against a predicted release cutoff. Absent on runs created
  // before the marker existed (fall back to the sequential path).
  hookResumeInputVersion: z.number().optional(),
});

export type HookResumeContext = z.infer<typeof HookResumeContextSchema>;

/**
 * Current version of the lazy-hook-resume consumer protocol. A run's creating
 * deployment stamps this into its execution context (and the server mirrors it
 * onto `HookResumeContext.hookResumeInputVersion`) to attest that its
 * `@workflow/core` re-ensures the `hook_received` event from a queue message's
 * `hookInput`. `resumeHook()`'s parallel fast path requires the target run's
 * marker to be at least this value. Bump only on a breaking change to the
 * `hookInput` re-ensure contract.
 */
export const HOOK_RESUME_INPUT_VERSION = 1;

/**
 * Current version of the backend lazy-hook-resume dedup contract: the live
 * backend enforces a `(runId, resumeId)` constraint so the direct write and the
 * queue consumer's re-ensure converge on exactly one `hook_received`.
 * `resumeHook()`'s parallel fast path requires the backend to attest at least
 * this version. Bump only on a breaking change to the constraint semantics.
 */
export const HOOK_RESUME_DEDUP_VERSION = 1;

/**
 * Backend-attested capabilities for lazy hook resume, computed FRESH on every
 * by-token hook lookup and returned inline on {@link HookSchema.resumeCapabilities}.
 *
 * Response-only and transient: NEVER persisted on the hook entity and NEVER
 * part of {@link HookResumeContextSchema}. Recomputing it per response is what
 * makes a server rollback or kill switch take effect immediately — a rolled-back
 * or kill-switched server simply stops emitting it, dropping new resumes to the
 * sequential path with no stranded hooks. (Contrast with the per-run, persisted
 * `hookResumeInputVersion`, which attests the *consumer* and is fixed at run
 * creation.)
 */
export const HookResumeCapabilitiesSchema = z.object({
  // Present (>= HOOK_RESUME_DEDUP_VERSION) when the live backend enforces the
  // `(runId, resumeId)` dedup constraint AND no server-side kill switch is
  // active. Absent against an older/rolled-back server or when the kill switch
  // is engaged.
  hookResumeDedupVersion: z.number(),
});

export type HookResumeCapabilities = z.infer<
  typeof HookResumeCapabilitiesSchema
>;

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
  // Backend dedup capability, computed FRESH by the server on every by-token
  // lookup — RESPONSE-ONLY and TRANSIENT. Never persisted on the hook entity
  // and never part of `resumeContext`, so a server rollback or kill switch
  // takes effect on the very next lookup (the field simply stops appearing).
  // `resumeHook()` gates its parallel fast path on this being present and
  // current. Absent against an older/rolled-back server or when the kill switch
  // is active.
  resumeCapabilities: HookResumeCapabilitiesSchema.optional(),
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
