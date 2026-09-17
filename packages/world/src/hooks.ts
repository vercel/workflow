import { z } from 'zod';
import { TraceCarrierSchema } from './queue.js';
import type { SerializedData } from './serialization.js';
import { SerializedDataSchema } from './serialization.js';
import type { PaginationOptions, ResolveData } from './shared.js';

/**
 * Minimal, immutable slice of a hook's owning run needed to resume it:
 * enough for encryption-key resolution, serialization/compression capability
 * selection, queue routing, and trace linking, without fetching the full run.
 *
 * Persisted on new hook records (workflow-server) and also returned inline by
 * `getByToken`, so a resume can skip the separate `runs.get`. Deliberately
 * excludes the run's mutable state (e.g. status), inputs/outputs, attributes,
 * and any secret: only fields that are fixed at hook-creation time.
 */
export const HookResumeContextSchema = z.compile(
  z.object({
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
    // `@workflow/core` re-ensures the `hook_received` event from a queue
    // message's `hookInput` on replay. Current producers no longer send
    // `hookInput` (the durable write happens before the wake is published), so
    // they never read this marker; it remains stamped so OLDER producers, which
    // still gate their lazy path on it, keep working against new runs. Because a
    // run is pinned to its creating deployment, this marker is a reliable
    // per-run attestation, unlike inferring support from a version compare
    // against a predicted release cutoff.
    hookResumeInputVersion: z.number().optional(),
  })
);

export type HookResumeContext = z.infer<typeof HookResumeContextSchema>;

/**
 * Current version of the lazy-hook-resume consumer protocol. A run's creating
 * deployment stamps this into its execution context (and the server mirrors it
 * onto `HookResumeContext.hookResumeInputVersion`) to attest that its
 * `@workflow/core` re-ensures the `hook_received` event from a queue message's
 * `hookInput`. Current producers write the event durably BEFORE publishing the
 * wake and do not read this marker; it exists for older producers whose lazy
 * path requires the target run's marker to be at least this value. Bump only
 * on a breaking change to the `hookInput` re-ensure contract.
 */
export const HOOK_RESUME_INPUT_VERSION = 1;

/**
 * Current version of the involuntary-hook-disposal READER contract: a runtime
 * at this version reads a `hook_disposed` carrying `forceClaimedBy` (written
 * into the run's log by another run's `createHook({ experimental_force })`)
 * as a takeover, rejects the hook's awaiters with `HookForceClaimedError` and
 * settles `getConflict()`. A runtime below it treats the row as its own
 * `dispose()` and leaves every `await hook` pending forever.
 *
 * Attested per run at `start()` by the deployment that will EXECUTE the run
 * — its own constant for a same-deployment start, the target's health-probe
 * answer for a cross-deployment one — and stamped into
 * `executionContext.hookForceClaimReaderVersion`. A World takes a token only
 * from a running victim whose run carries at least this value; an older
 * deployment, a Python runtime, or an unattested target never does, so a
 * takeover can never strand a run that would not understand it. Deliberately
 * NOT tied to the spec version: that is stamped by the starter, not the
 * executor, and bumping it forces every reader in the fleet to move at once.
 */
export const HOOK_FORCE_CLAIM_READER_VERSION = 1;

/**
 * Whether a run, from its stamped `executionContext`, may have a hook token
 * taken from it while it is running: its executing deployment attested a
 * reader version of at least {@link HOOK_FORCE_CLAIM_READER_VERSION} at
 * `start()`. Fails closed: a run started by an older SDK (no stamp), on a
 * Python runtime, or whose cross-deployment target did not answer the probe
 * is never taken from. Worlds decide from the VICTIM's persisted context,
 * never from the claiming request.
 */
export function runUnderstandsForcedHookDisposal(
  executionContext: Record<string, unknown> | null | undefined
): boolean {
  const version = executionContext?.hookForceClaimReaderVersion;
  return (
    typeof version === 'number' && version >= HOOK_FORCE_CLAIM_READER_VERSION
  );
}

/**
 * Current version of the backend lazy-hook-resume dedup contract: the live
 * backend enforces a `(runId, resumeId)` constraint so repeated deliveries of
 * one resume's queue message converge on exactly one `hook_received`.
 * `resumeHook()`'s lazy path requires the backend to attest at least this
 * version. Bump only on a breaking change to the constraint semantics.
 */
export const HOOK_RESUME_DEDUP_VERSION = 1;

/**
 * Backend-attested capabilities for lazy hook resume, computed FRESH on every
 * by-token hook lookup and returned inline on {@link HookSchema.resumeCapabilities}.
 *
 * Response-only and transient: NEVER persisted on the hook entity and NEVER
 * part of {@link HookResumeContextSchema}. Recomputing it per response is what
 * makes a server rollback or kill switch take effect immediately: a rolled-back
 * or kill-switched server stops emitting it, dropping new resumes to the
 * sequential path with no stranded hooks. (Contrast with the per-run, persisted
 * `hookResumeInputVersion`, which attests the *consumer* and is fixed at run
 * creation.)
 */
export const HookResumeCapabilitiesSchema = z.compile(
  z.object({
    // Present (>= HOOK_RESUME_DEDUP_VERSION) when the live backend enforces the
    // `(runId, resumeId)` dedup constraint AND no server-side kill switch is
    // active. Absent against an older/rolled-back server or when the kill switch
    // is engaged.
    hookResumeDedupVersion: z.number(),
  })
);

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
/**
 * Who a force-claimed hook took its token from. Written by the World in the
 * same transaction that re-points the token, and returned on the
 * `hook_created` response and on every later read of the hook.
 *
 * `workflowName`, `deploymentId` and `runSpecVersion` are the VICTIM run's:
 * the claimer's runtime publishes the victim's wake from them (the victim's
 * replay has to read the `hook_disposed{forceClaimedBy}` row the takeover
 * left in its log). They are optional only because a World may not have them
 * for a legacy victim; when absent the runtime skips the wake and the victim
 * reads the row on its next invocation.
 */
export const HookClaimedFromSchema = z.compile(
  z.object({
    runId: z.string(),
    hookId: z.string(),
    workflowName: z.string().optional(),
    deploymentId: z.string().optional(),
    runSpecVersion: z.number().optional(),
  })
);
export type HookClaimedFrom = z.infer<typeof HookClaimedFromSchema>;

// Hook schemas
export const HookSchema = z.compile(
  z.object({
    runId: z.string(),
    hookId: z.string(),
    token: z.string(),
    ownerId: z.string(),
    projectId: z.string(),
    environment: z.string(),
    metadata: SerializedDataSchema.optional(),
    createdAt: z.coerce.date(),
    // Optional in database for backward compatibility, defaults to 1 (legacy) when reading
    specVersion: z.number().optional(),
    isWebhook: z.boolean().optional(),
    isSystem: z.boolean().optional(),
    // Earliest time the token can become available after the owning run ends.
    // An active run keeps the token beyond this deadline.
    tokenRetentionUntil: z.coerce.date().optional(),
    // Present when the server stored it (new hooks) or synthesized it from the
    // run (old hooks). Absent only against an old server, where the resume path
    // falls back to `runs.get`.
    resumeContext: HookResumeContextSchema.optional(),
    // Backend dedup capability, computed FRESH by the server on every by-token
    // lookup: RESPONSE-ONLY and TRANSIENT. Never persisted on the hook entity
    // and never part of `resumeContext`, so a server rollback or kill switch
    // takes effect on the next lookup (the field stops appearing).
    // `resumeHook()` gates its lazy path on this being present and
    // current. Absent against an older/rolled-back server or when the kill switch
    // is active.
    resumeCapabilities: HookResumeCapabilitiesSchema.optional(),
    // Set when this hook took its token from another run
    // (`experimental_force`). The wake-targeting fields are the victim run's,
    // so the claimer's runtime can publish the victim's wake without reading
    // a run it may not be able to reach; see `HookClaimedFromSchema`.
    claimedFrom: HookClaimedFromSchema.optional(),
  })
);

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
