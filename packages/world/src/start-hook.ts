import { z } from 'zod';
import { SerializedDataSchema } from './serialization.js';

/**
 * Atomic start Hook admission: `start(workflow, args, { hook: { token } })`.
 *
 * The World creates a Hook for the token while it admits the run, so at most
 * one run owns the token and a duplicate start is refused before it becomes a
 * run. This module holds the parts of that contract every World and the
 * runtime share: the request shape, the start Hook's id and the wire codes a
 * remote World answers with.
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
 *   become free or been taken, until the orphan bound below: past it, a
 *   `run_created` for the candidate is refused with
 *   `START_HOOK_ADMISSION_REJECTED` even if it was decided (`start()` only
 *   retries with a new candidate, so nothing waits on that decision):
 *   - accepted: the run is created together with its start Hook, and repeated
 *     attempts return that run (never `EntityConflictError`);
 *   - rejected: no run, Hook or events are created for the candidate, and
 *     repeated attempts throw `HookConflictError` with the same
 *     `conflictingRunId`.
 * - **The start Hook.** Accepting a candidate creates a real Hook with id
 *   {@link startHookId}`(runId)`: `{ token, runId, metadata,
 *   tokenRetentionUntil, isWebhook: false }` from the request. It is created
 *   atomically with the token claim and the decision (or a crash between
 *   them is recoverable by re-attempting the candidate), and no
 *   `hook_created` is ever written for it: the run's `run_created` stands
 *   for its creation. From the moment the admitting write returns,
 *   `hooks.getByToken(token)` and `hooks.get(startHookId(runId))` return it,
 *   and a `hook_received` for it is accepted, including while the run is
 *   still `pending` (an exception to the running-only rule that applies to
 *   the start Hook's id alone). A `hook_created` whose `correlationId` is
 *   `startHookId(runId)` is refused as invalid (400): the id belongs to the
 *   start Hook.
 * - **Lifecycle.** From then on the start Hook is an ordinary Hook, exactly as
 *   if the run had called `createHook({ token, experimental_minRetention })`
 *   with the same retention: other runs' `createHook()` with the token
 *   conflict naming the owner, `hook_disposed` frees the token at once (even
 *   with a retention set), and the run's end frees it unless
 *   `tokenRetentionUntil` is still in the future, in which case the Hook stays
 *   readable, refuses deliveries, and holds the token until then. A forced
 *   `createHook({ experimental_force })` takes it like any Hook, even before
 *   the workflow first opens it: the owner's log gets `hook_disposed` with
 *   `forceClaimedBy` for `startHookId(runId)`.
 * - **Atomicity.** A rejected candidate never creates a run, and neither does
 *   a candidate whose admission was released as an orphan: once its token
 *   has moved on, a writer that stalled before creating its run must not be
 *   able to create it when it resumes.
 * - **Echo.** The `run` a `run_created` returns for an accepted candidate
 *   carries the request as `run.startHook`, with `hookId`. A backend that
 *   ignored the field would create a run without its Hook; the echo is how
 *   `start()` tells the two apart. `runs.get` and the `run_started` response
 *   carry it too, and so does the stored `run_created.eventData.startHook`
 *   (`{ token, hookId, tokenRetentionUntil? }`; a World may strip
 *   `metadata`): the runtime binds the workflow's `createHook({ token })` to
 *   the start Hook from it on every replay.
 * - **Orphans.** A candidate accepted but never created (the creating writer
 *   died or stalled before its run existed) holds its token for the World's
 *   hold, resolves as not found, and accepts no resumes: nobody was told it
 *   was admitted. Once the candidate's `runId` is older than
 *   {@link START_HOOK_CANDIDATE_MAX_AGE_MS} (the same bound `run_created`
 *   already enforces on client-minted ids) it can never be created, its token
 *   is free, and further attempts for it are refused with
 *   `START_HOOK_ADMISSION_REJECTED`.
 * - **Permanent refusals.** A request the World will never admit (invalid
 *   `startHook`, retention beyond the World's limit, the feature disabled)
 *   throws `WorkflowWorldError` with code `START_HOOK_ADMISSION_REJECTED`, so
 *   the queued copy stops retrying without hiding unrelated World errors.
 *
 * `@workflow/world`'s `test-support/atomic-start-hook-conformance.ts` checks
 * these rules against a World's storage.
 */
export const StartHookSchema = z.object({
  /** The start Hook's token. Non-empty. */
  token: z.string().min(1),
  /**
   * The start Hook's id, {@link startHookId}`(runId)`. Set by the World on
   * what it returns (`run.startHook` and the stored
   * `run_created.eventData.startHook`); ignored on requests, since the id is
   * derived from the run's.
   */
  hookId: z.string().optional(),
  /**
   * The start Hook's minimum retention, like `createHook()`'s
   * `tokenRetentionUntil`: once the run has ended, the Hook keeps its token
   * until this time has passed. Disposing the Hook frees the token earlier.
   * Requires `capabilities.hookRetention`.
   */
  tokenRetentionUntil: z.coerce.date().optional(),
  /**
   * The start Hook's metadata, serialized like `createHook({ metadata })`'s
   * (the same bytes `hook_created.eventData.metadata` carries).
   */
  metadata: SerializedDataSchema.optional(),
});
export type StartHook = z.infer<typeof StartHookSchema>;

/**
 * Age past which an accepted-but-uncreated candidate can never be created and
 * its token is free. Equal to the past threshold `run_created` applies
 * to client-minted run ids (`DEFAULT_TIMESTAMP_THRESHOLD_PAST_MS`), which is
 * itself the longest a resilient-start queue message can be delayed.
 */
export const START_HOOK_CANDIDATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The id of a run's start Hook, derived from the run's id (`wrun_<ulid>` →
 * `hook_<ulid>`). The admission that creates the run creates this Hook, so it
 * exists, and can be resumed, from the moment the run is admitted, with no
 * `hook_created` of its own: `run_created` stands for it. The workflow's
 * `createHook({ token })` with the start token binds to this id.
 */
export function startHookId(runId: string): string {
  if (!runId.startsWith('wrun_') || runId.length <= 'wrun_'.length) {
    throw new Error(`Not a workflow run id: "${runId}"`);
  }
  return `hook_${runId.slice('wrun_'.length)}`;
}

/** Whether `hookId` is the start Hook of the run `runId`. */
export function isStartHookId(runId: string, hookId: string): boolean {
  return runId.startsWith('wrun_') && hookId === startHookId(runId);
}

/**
 * `WorkflowWorldError.code` for a start Hook request the World will never
 * admit. Mirrors `START_HOOK_ADMISSION_REJECTED` in `@workflow/errors`, which
 * `@workflow/world` cannot depend on.
 */
export const START_HOOK_ADMISSION_REJECTED_CODE =
  'START_HOOK_ADMISSION_REJECTED';

/**
 * Why a World refused a start Hook request with
 * {@link START_HOOK_ADMISSION_REJECTED_CODE}, carried as
 * `WorkflowWorldError.reason`:
 *
 * - `invalid`: the request itself, such as a retention beyond the World's
 *   limit;
 * - `expired`: the candidate is too old to be created;
 * - `token_mismatch`: the candidate was already decided under another token;
 * - `ordinary_run`: its run id names a run created without a start Hook;
 * - `disabled`: refused, and recorded as refused, while admission was off.
 *
 * {@link START_HOOK_ADMISSION_DISABLED_CODE} carries `disabled` too.
 */
export type StartHookRejectionReason =
  | 'invalid'
  | 'expired'
  | 'token_mismatch'
  | 'ordinary_run'
  | 'disabled';

/**
 * `WorkflowWorldError.code` for a start Hook request answered while admission
 * is switched off, with nothing recorded for the candidate, so another copy
 * may still be admitted later. Mirrors `START_HOOK_ADMISSION_DISABLED` in
 * `@workflow/errors`.
 */
export const START_HOOK_ADMISSION_DISABLED_CODE =
  'START_HOOK_ADMISSION_DISABLED';

/**
 * `WorkflowWorldError.code` for a `run_cancelled` of a candidate that was
 * admitted but never became a run: the World fenced it instead. Mirrors
 * `START_HOOK_CANDIDATE_CANCELLED` in `@workflow/errors`.
 */
export const START_HOOK_CANDIDATE_CANCELLED_CODE =
  'START_HOOK_CANDIDATE_CANCELLED';

/**
 * Wire codes a remote World (workflow-server) answers a start Hook admission
 * with, in the JSON error body's `error` (or `code`) field:
 *
 * - `409 start-hook-conflict`: the candidate was refused. The body carries
 *   `token` and `conflictingRunId` at the top level. Maps to
 *   `HookConflictError(token, conflictingRunId)`.
 * - `400 start-hook-admission-rejected`: a permanent refusal, the same for
 *   every copy of the candidate, with `details.reason` a
 *   {@link StartHookRejectionReason}. Maps to `WorkflowWorldError` with code
 *   {@link START_HOOK_ADMISSION_REJECTED_CODE} and that `reason`.
 * - `400 start-hook-disabled`: admission is switched off on the backend (kill
 *   switch) and nothing was recorded for the candidate, so it is not final.
 *   Maps to {@link START_HOOK_ADMISSION_DISABLED_CODE}. A backend that records
 *   the refusal as the candidate's decision answers
 *   `start-hook-admission-rejected` instead. Never answered by silently
 *   ignoring `startHook`.
 *
 * - `409 start-hook-candidate-cancelled`: a `run_cancelled` reached a
 *   candidate that was admitted but has no run; the backend fenced it, so no
 *   copy can create it. Maps to {@link START_HOOK_CANDIDATE_CANCELLED_CODE}.
 *
 * Contention the backend could not settle answers a plain 429, which stays
 * retryable.
 */
export const START_HOOK_WIRE_CODES = {
  conflict: 'start-hook-conflict',
  admissionRejected: 'start-hook-admission-rejected',
  disabled: 'start-hook-disabled',
  candidateCancelled: 'start-hook-candidate-cancelled',
} as const;
