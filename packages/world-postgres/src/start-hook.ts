import {
  HookConflictError,
  START_HOOK_ADMISSION_REJECTED,
  WorkflowWorldError,
} from '@workflow/errors';
import { debugLog } from '@workflow/utils';
import {
  START_HOOK_CANDIDATE_MAX_AGE_MS,
  type StartHook,
  startHookId,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  ulidToDate,
} from '@workflow/world';
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import {
  type DrizzleHandle,
  type DrizzleTransaction,
  Schema,
} from './drizzle/index.js';
import type { RunStartHook, SerializedContent } from './drizzle/schema.js';

/**
 * `start({ hook })` admission for world-postgres. See `start-hook.ts` in
 * @workflow/world for the contract.
 *
 * An accepted candidate's admission inserts its start Hook, an ordinary row
 * in `workflow_hooks` with hook id `startHookId(runId)`, in the transaction
 * that records the decision and creates the run. From that commit on the
 * Hook resolves by token and accepts deliveries like any Hook, and it follows
 * the ordinary Hook lifecycle: `hook_disposed` deletes the row, and the run's
 * end deletes it unless its `token_retention_until` is in the future. No
 * `hook_created` is ever written for it: `run_created` stands for it.
 *
 * The start Hook row claims its token (`claims_token`), and a partial unique
 * index allows one claiming row per token, so two admissions racing for one
 * token conflict on the insert instead of both winning. Postgres has no
 * orphan state: the decision, the Hook row and the run commit together or
 * not at all.
 */

/** The constraint a second claim of one token violates. */
export const HOOK_TOKEN_CLAIM_UNIQUE = 'workflow_hooks_token_claim_unique';

/** The start Hook as the run's `run_created` event carries it. */
export function admittedStartHook(
  runId: string,
  startHook: StartHook
): StartHook & { hookId: string } {
  return { ...startHook, hookId: startHookId(runId) };
}

/** The start Hook without its metadata: what the run row keeps. */
export function runStartHook(
  runId: string,
  startHook: StartHook
): RunStartHook {
  const { metadata: _metadata, ...rest } = startHook;
  return { ...rest, hookId: startHookId(runId) };
}

const hooks = Schema.hooks;

/** The hook row's owner run is terminal. */
function ownerRunIsTerminal(db: DrizzleHandle) {
  return db
    .select({ runId: Schema.runs.runId })
    .from(Schema.runs)
    .where(
      and(
        eq(Schema.runs.runId, hooks.runId),
        inArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
      )
    );
}

/** A hook row still holds its token: its run is live, or retention left. */
function holdsToken(db: DrizzleHandle) {
  return or(
    gt(hooks.tokenRetentionUntil, sql`now()`),
    notExists(ownerRunIsTerminal(db))
  );
}

/** The run owning an active row of `token`, other than `excludeRunId`. */
async function findActiveTokenOwner(
  tx: DrizzleTransaction,
  token: string,
  excludeRunId: string
): Promise<string | undefined> {
  const [row] = await tx
    .select({ runId: hooks.runId })
    .from(hooks)
    .where(
      and(eq(hooks.token, token), ne(hooks.runId, excludeRunId), holdsToken(tx))
    )
    .limit(1);
  return row?.runId;
}

export type StartHookDecision =
  | { decision: 'accepted'; replayed: boolean }
  | { decision: 'rejected'; conflictingRunId: string }
  /** The run exists with no decision: created without a start Hook. */
  | { decision: 'ordinary' };

/**
 * Decides admission for candidate `runId` inside the transaction that would
 * create its run.
 *
 * - A recorded decision is returned as-is (`replayed: true` for an accepted
 *   one, whose run already exists).
 * - A run that exists with no decision was created without a start Hook
 *   (by a worker that predates start Hooks): `ordinary`, and nothing is
 *   written.
 * - A new candidate is accepted when no other run holds the token, writing
 *   its start Hook row and `accepted`; the caller then creates the run in
 *   the same transaction.
 * - Otherwise it is rejected, recording the owner. The caller must commit the
 *   transaction and then throw {@link startHookConflict}.
 */
export async function decideStartHookAdmission(
  tx: DrizzleTransaction,
  runId: string,
  startHook: StartHook,
  specVersion: number
): Promise<StartHookDecision> {
  const recorded = await recordedDecision(tx, runId, startHook);
  if (recorded) return recorded;

  // Orphan bound: a candidate this old can never be created. It also bounds
  // how long a decision matters, which is what lets old rows be deleted.
  const candidateTime = ulidToDate(runId.replace(/^wrun_/, ''));
  if (
    candidateTime &&
    Date.now() - candidateTime.getTime() > START_HOOK_CANDIDATE_MAX_AGE_MS
  ) {
    throw new WorkflowWorldError(
      `Workflow run "${runId}" is too old to be admitted with a start Hook`,
      { status: 400, code: START_HOOK_ADMISSION_REJECTED, reason: 'expired' }
    );
  }

  const [run] = await tx
    .select({ runId: Schema.runs.runId })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, runId))
    .limit(1);
  if (run) return { decision: 'ordinary' };

  await deleteExpiredDecisions(tx);
  // A Hook whose run ended and whose retention passed no longer holds the
  // token, and would block the start Hook's unique claim.
  const released = await tx
    .delete(hooks)
    .where(
      and(
        eq(hooks.token, startHook.token),
        exists(ownerRunIsTerminal(tx)),
        or(
          isNull(hooks.tokenRetentionUntil),
          lte(hooks.tokenRetentionUntil, sql`now()`)
        )
      )
    )
    .returning({ runId: hooks.runId });
  for (const { runId: previousRunId } of released) {
    startHookLog("released an ended owner's token", { runId, previousRunId });
  }

  const owner = await findActiveTokenOwner(tx, startHook.token, runId);
  const [startHookRow] = owner
    ? []
    : await tx
        .insert(hooks)
        .values({
          runId,
          hookId: startHookId(runId),
          token: startHook.token,
          ownerId: '',
          projectId: '',
          environment: '',
          tokenRetentionUntil: startHook.tokenRetentionUntil,
          metadata: startHook.metadata as SerializedContent | undefined,
          specVersion,
          isWebhook: false,
          isSystem: false,
          claimsToken: true,
        })
        // Untargeted: the other copy of this candidate inserts the same
        // `hook_id` as well as the same claim.
        .onConflictDoNothing()
        .returning({ hookId: hooks.hookId });
  if (!startHookRow) {
    // Another claim committed first (the unique insert waited for it): the
    // other copy of this same candidate, whose decision is now visible, or
    // another run.
    const raced = await recordedDecision(tx, runId, startHook);
    if (raced) return raced;
    const conflictingRunId =
      owner ?? (await findActiveTokenOwner(tx, startHook.token, runId));
    if (!conflictingRunId) {
      throw new WorkflowWorldError(
        `The start Hook token of candidate "${runId}" changed owner while being admitted; retry`,
        { status: 503 }
      );
    }
    return recordDecision(
      tx,
      runId,
      startHook,
      { decision: 'rejected', conflictingRunId },
      { decision: 'rejected', conflictingRunId }
    );
  }
  return recordDecision(
    tx,
    runId,
    startHook,
    { decision: 'accepted' },
    { decision: 'accepted', replayed: false }
  );
}

/**
 * Records the decision, unless the other copy of this candidate recorded one
 * first (both can decide a refusal concurrently: neither writes the Hook
 * row that would serialize them). That one wins, as it would for any later
 * attempt. An acceptance that loses to a refusal must not commit: its start
 * Hook, already written in this transaction, would hold the token for a run
 * that is never created. It answers a retryable error instead, which rolls
 * the Hook back, and the retry replays the refusal.
 */
async function recordDecision(
  tx: DrizzleTransaction,
  runId: string,
  startHook: StartHook,
  row: { decision: 'accepted' | 'rejected'; conflictingRunId?: string },
  decided: StartHookDecision
): Promise<StartHookDecision> {
  const [inserted] = await tx
    .insert(Schema.startHookAdmissions)
    .values({ runId, token: startHook.token, ...row })
    .onConflictDoNothing({ target: Schema.startHookAdmissions.runId })
    .returning({ runId: Schema.startHookAdmissions.runId });
  if (inserted) {
    startHookLog(
      row.decision === 'accepted'
        ? 'accepted a candidate'
        : 'refused a candidate',
      {
        runId,
        ...(row.conflictingRunId
          ? { conflictingRunId: row.conflictingRunId }
          : {}),
      }
    );
    return decided;
  }
  const recorded = await recordedDecision(tx, runId, startHook);
  if (
    !recorded ||
    (row.decision === 'accepted' && recorded.decision !== 'accepted')
  ) {
    throw new WorkflowWorldError(
      `Workflow run "${runId}" was decided by another write while being admitted; retry`,
      { status: 503 }
    );
  }
  return recorded;
}

/** The decision recorded for candidate `runId`, if any. */
async function recordedDecision(
  tx: DrizzleTransaction,
  runId: string,
  startHook: StartHook
): Promise<StartHookDecision | undefined> {
  const admissions = Schema.startHookAdmissions;
  const [existing] = await tx
    .select()
    .from(admissions)
    .where(eq(admissions.runId, runId))
    .limit(1);
  if (!existing) return undefined;
  if (existing.token !== startHook.token) {
    throw new WorkflowWorldError(
      `Workflow run "${runId}" was already admitted with a different start Hook token`,
      {
        status: 400,
        code: START_HOOK_ADMISSION_REJECTED,
        reason: 'token_mismatch',
      }
    );
  }
  return existing.decision === 'accepted'
    ? { decision: 'accepted', replayed: true }
    : {
        decision: 'rejected',
        conflictingRunId: existing.conflictingRunId ?? '',
      };
}

/**
 * Deletes a bounded batch of decisions older than every candidate window: no
 * attempt for those candidates can be admitted any more, so nothing reads
 * them. Bounded so one admission never pays for a backlog.
 */
async function deleteExpiredDecisions(tx: DrizzleTransaction): Promise<void> {
  const admissions = Schema.startHookAdmissions;
  const cutoff = new Date(
    Date.now() - START_HOOK_CANDIDATE_MAX_AGE_MS - 60 * 60 * 1000
  );
  await tx.execute(
    // SKIP LOCKED: rows another admission is already deleting are left to
    // it, so admissions of unrelated tokens never wait on each other here.
    sql`delete from ${admissions} where ${admissions.runId} in (select ${admissions.runId} from ${admissions} where ${admissions.createdAt} < ${cutoff.toISOString()}::timestamptz limit 100 for update skip locked)`
  );
}

/** The refusal a rejected decision answers with, after its commit. */
export function startHookConflict(
  startHook: StartHook,
  conflictingRunId: string
): HookConflictError {
  return new HookConflictError(startHook.token, conflictingRunId);
}

/**
 * A start Hook admission breadcrumb, under `DEBUG=workflow:*`. Written inside
 * the deciding transaction, so a rolled-back attempt can log too. Names runs,
 * never the token: a token is the caller's idempotency key and may carry user
 * data.
 */
function startHookLog(message: string, detail: Record<string, string>): void {
  debugLog(`[world-postgres] start Hook: ${message}`, detail);
}
