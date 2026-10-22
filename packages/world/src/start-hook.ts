import { z } from 'zod';
import { SerializedDataSchema } from './serialization.js';

/**
 * Atomic start Hook admission: `start(workflow, args, { hook: { token } })`.
 *
 * The World reserves a Hook token while it admits the run, so at most one run
 * owns the token and a duplicate start is refused before it becomes a run.
 * This module holds the parts of that contract every World and the runtime
 * share: the request shape and the wire codes a remote World answers with.
 *
 * The contract a World advertising `capabilities.atomicStartHook` follows:
 *
 * - **Where it applies.** `run_created.eventData.startHook` and resilient
 *   `run_started.eventData.startHook`. `start()` publishes the candidate's
 *   queue message first and then writes `run_created`; the queued copy writes
 *   `run_started` with the same `startHook` from its `runInput`. Either may
 *   arrive first, and both must reach the same decision.
 * - **One immutable decision per candidate `runId`.** The first admission
 *   attempt for a candidate decides it. Every later attempt for that `runId`,
 *   through either path, returns that decision even if the token has since
 *   become free or been taken:
 *   - accepted: the run is created with the token reserved, and repeated
 *     attempts return that run (never `EntityConflictError`);
 *   - rejected: no run or events are created for the candidate, and repeated
 *     attempts throw `HookConflictError` with the same `conflictingRunId`.
 * - **Atomicity.** The token reservation and the run's creation commit
 *   together, or a crash between them is recoverable by re-attempting the
 *   candidate. A rejected candidate never creates a run.
 * - **Echo.** The `run` a `run_created` returns for an accepted candidate
 *   carries the reservation as `run.startHook`. A backend that ignored the
 *   field would create an unreserved run; the echo is how `start()` tells the
 *   two apart. (A resilient `run_started` response need not echo it.)
 * - **Ownership.** The token is unavailable to every other run (start
 *   reservations and `createHook()` alike) until the owning run has ended AND
 *   `tokenRetentionUntil` (when set) has passed.
 * - **Adoption.** The owning run may `createHook({ token })` with the same
 *   token. That materializes the reservation as a Hook rather than
 *   conflicting. The Hook's own `tokenRetentionUntil` may extend the
 *   reservation but never shortens it, and disposing the Hook does not release
 *   the reservation before the run ends.
 *   The reservation's `metadata` carries over to the adopted Hook unless the
 *   `createHook()` passes its own, which wins.
 * - **Force claims.** `createHook({ experimental_force })` against an adopted
 *   reservation transfers the reservation, retention included, with the
 *   Hook, so the claimer owns the token until it ends (a handoff whose source
 *   run stays parked must not pin the token to it). A reservation not yet
 *   adopted cannot be force-claimed (`hook_conflict`).
 * - **Lookups before adoption.** A reservation whose run has not adopted it is
 *   not a Hook yet, but the token has an owner: a by-token lookup (and so
 *   `resumeHook()`) throws `HookReservedError` naming the run, retryable,
 *   while that run has not ended. It answers not found once the run ended
 *   without adopting it, or after the adopted Hook was disposed.
 * - **Orphan bound.** A candidate accepted but never created (the creating
 *   writer died after deciding) must not hold the token forever. Once the
 *   candidate's `runId` is older than {@link START_HOOK_CANDIDATE_MAX_AGE_MS}
 *   (the same bound `run_created` already enforces on client-minted ids) it
 *   can never be created, its reservation is released, and further attempts
 *   for it are refused with `START_HOOK_ADMISSION_REJECTED`.
 * - **Permanent refusals.** A request the World will never admit (invalid
 *   `startHook`, retention beyond the World's limit, the feature disabled)
 *   throws `WorkflowWorldError` with code `START_HOOK_ADMISSION_REJECTED`, so
 *   the queued copy stops retrying without hiding unrelated World errors.
 *
 * `@workflow/world`'s `test-support/atomic-start-hook-conformance.ts` checks
 * these rules against a World's storage.
 */
export const StartHookSchema = z.object({
  /** The Hook token reserved for the run. Non-empty. */
  token: z.string().min(1),
  /**
   * Absolute minimum retention: the token stays unavailable until both the
   * run has ended and this time has passed. Requires
   * `capabilities.hookRetention`.
   */
  tokenRetentionUntil: z.coerce.date().optional(),
  /**
   * The Hook's metadata, serialized like `createHook({ metadata })`'s (the
   * same bytes `hook_created.eventData.metadata` carries). The World stores
   * it with the reservation and gives it to the adopted Hook when the run's
   * `createHook()` passes none.
   */
  metadata: SerializedDataSchema.optional(),
});
export type StartHook = z.infer<typeof StartHookSchema>;

/**
 * Age past which an accepted-but-uncreated candidate can never be created and
 * its reservation is free. Equal to the past threshold `run_created` applies
 * to client-minted run ids (`DEFAULT_TIMESTAMP_THRESHOLD_PAST_MS`), which is
 * itself the longest a resilient-start queue message can be delayed.
 */
export const START_HOOK_CANDIDATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * `WorkflowWorldError.code` for a start Hook request the World will never
 * admit. Mirrors `START_HOOK_ADMISSION_REJECTED` in `@workflow/errors`, which
 * `@workflow/world` cannot depend on.
 */
export const START_HOOK_ADMISSION_REJECTED_CODE =
  'START_HOOK_ADMISSION_REJECTED';

/**
 * Wire codes a remote World (workflow-server) answers a start Hook admission
 * with, in the JSON error body's `error` (or `code`) field:
 *
 * - `409 start-hook-conflict`: the candidate was refused. The body carries
 *   `token` and `conflictingRunId` at the top level. Maps to
 *   `HookConflictError(token, conflictingRunId)`.
 * - `400 start-hook-admission-rejected`: a permanent validation failure.
 * - `400 start-hook-disabled`: admission is switched off on the backend (kill
 *   switch). Never answered by silently ignoring `startHook`.
 *
 * Both 400 codes map to `WorkflowWorldError` with code
 * {@link START_HOOK_ADMISSION_REJECTED_CODE}. Contention the backend could
 * not settle answers a plain 429, which stays retryable.
 *
 * A by-token Hook lookup (or a `hook_received`) that lands on a reservation
 * its run has not adopted answers `425 hook-reserved` with `runId` at the top
 * level and a `Retry-After` header, writing nothing. Maps to
 * `HookReservedError(token, runId, { retryAfter })`.
 */
export const START_HOOK_WIRE_CODES = {
  conflict: 'start-hook-conflict',
  admissionRejected: 'start-hook-admission-rejected',
  disabled: 'start-hook-disabled',
  reserved: 'hook-reserved',
} as const;

/**
 * Seconds a World suggests between retries of a lookup refused with
 * `HookReservedError`: the owner is usually registering its Hook within a
 * delivery or two.
 */
export const HOOK_RESERVED_RETRY_AFTER_SECONDS = 1;
