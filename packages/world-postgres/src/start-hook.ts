import {
  HookConflictError,
  START_HOOK_ADMISSION_REJECTED,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type SerializedData,
  START_HOOK_CANDIDATE_MAX_AGE_MS,
  type StartHook,
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
import type { SerializedContent } from './drizzle/schema.js';

/**
 * `start({ hook })` admission for world-postgres. See `start-hook.ts` in
 * @workflow/world for the contract.
 *
 * A reservation is a placeholder row in `workflow_hooks`
 * (`is_start_reservation`), so the by-token read every Hook creation and
 * lookup already does finds it, and nothing that never uses `start({ hook })`
 * pays for it. The placeholder holds the token for its run (`run_id`, the
 * candidate until a forced `createHook()` moves it) while that run is not
 * terminal or its `token_retention_until` is in the future, like any Hook row.
 *
 * Rows this version writes claim their token (`claims_token`), and a partial
 * unique index allows one claiming row per token, so an admission racing a
 * Hook creation for the same token conflicts on the insert instead of both
 * winning. The decision and the run it admits commit in one transaction, so
 * an accepted candidate always has its run.
 */

/** The `hook_id` of a candidate's reservation placeholder. */
export function startReservationHookId(candidateRunId: string): string {
  return `shr_${candidateRunId}`;
}

/** The constraint a second claim of one token violates. */
export const HOOK_TOKEN_CLAIM_UNIQUE = 'workflow_hooks_token_claim_unique';

/** `token` with its metadata dropped: what the run row keeps. */
export function startHookWithoutMetadata(
  startHook: StartHook
): Omit<StartHook, 'metadata'> {
  const { metadata: _metadata, ...rest } = startHook;
  return rest;
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
  /** The run exists with no decision: created without the reservation. */
  | { decision: 'unreserved' };

/**
 * Decides admission for candidate `runId` inside the transaction that would
 * create its run.
 *
 * - A recorded decision is returned as-is (`replayed: true` for an accepted
 *   one, whose run already exists).
 * - A run that exists with no decision was created without the reservation
 *   (by a worker that predates start Hooks): `unreserved`, and nothing is
 *   written.
 * - A new candidate is accepted when no other run holds the token, writing
 *   its placeholder and `accepted`; the caller then creates the run in the
 *   same transaction.
 * - Otherwise it is rejected, recording the owner. The caller must commit the
 *   transaction and then throw {@link startHookConflict}.
 */
export async function decideStartHookAdmission(
  tx: DrizzleTransaction,
  runId: string,
  startHook: StartHook,
  specVersion: number
): Promise<StartHookDecision> {
  const admissions = Schema.startHookAdmissions;
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
      { status: 400, code: START_HOOK_ADMISSION_REJECTED }
    );
  }

  const [run] = await tx
    .select({ runId: Schema.runs.runId })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, runId))
    .limit(1);
  if (run) return { decision: 'unreserved' };

  await deleteExpiredDecisions(tx);
  // A claim whose run ended and whose retention passed no longer holds the
  // token, and would block the placeholder's unique claim.
  await tx
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
    );

  const owner = await findActiveTokenOwner(tx, startHook.token, runId);
  const [placeholder] = owner
    ? []
    : await tx
        .insert(hooks)
        .values({
          runId,
          hookId: startReservationHookId(runId),
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
          isStartReservation: true,
        })
        .onConflictDoNothing({
          target: hooks.token,
          where: sql`${hooks.claimsToken}`,
        })
        .returning({ hookId: hooks.hookId });
  if (!placeholder) {
    // Another claim committed first (the unique insert waited for it): the
    // other copy of this same candidate, whose decision is now visible, or
    // another run.
    const raced = await recordedDecision(tx, runId, startHook);
    if (raced) return raced;
    const conflictingRunId =
      owner ?? (await findActiveTokenOwner(tx, startHook.token, runId));
    if (!conflictingRunId) {
      throw new WorkflowWorldError(
        `Hook token "${startHook.token}" changed owner while being admitted; retry`,
        { status: 503 }
      );
    }
    await tx.insert(admissions).values({
      runId,
      token: startHook.token,
      decision: 'rejected',
      conflictingRunId,
    });
    return { decision: 'rejected', conflictingRunId };
  }
  await tx.insert(admissions).values({
    runId,
    token: startHook.token,
    decision: 'accepted',
  });
  return { decision: 'accepted', replayed: false };
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
      { status: 400, code: START_HOOK_ADMISSION_REJECTED }
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
    sql`delete from ${admissions} where ${admissions.runId} in (select ${admissions.runId} from ${admissions} where ${admissions.createdAt} < ${cutoff.toISOString()}::timestamptz limit 100)`
  );
}

/** The refusal a rejected decision answers with, after its commit. */
export function startHookConflict(
  startHook: StartHook,
  conflictingRunId: string
): HookConflictError {
  return new HookConflictError(startHook.token, conflictingRunId);
}

/** `greatest(column, until)`, treating a null column as `until`. */
function extendedRetention(until: string) {
  return sql`greatest(coalesce(${hooks.tokenRetentionUntil}, ${until}::timestamptz), ${until}::timestamptz)`;
}

/**
 * Moves the reservation `fromRunId` holds on `token` to `toRunId`. Used by a
 * forced `createHook()` that takes the reservation's materialized Hook: the
 * reservation follows the Hook, so the claimer owns the token until it ends.
 * The claimer's Hook retention extends it as an adoption's does, so it
 * outlives that Hook's disposal. Returns whether there was one to move.
 */
export async function transferStartReservation(
  tx: DrizzleTransaction,
  token: string,
  fromRunId: string,
  toRunId: string,
  hookRetentionUntil: Date | undefined
): Promise<boolean> {
  const until = hookRetentionUntil?.toISOString();
  const moved = await tx
    .update(hooks)
    .set({
      runId: toRunId,
      // The start's metadata stays with the start's run, not the claimer.
      metadata: null,
      ...(until ? { tokenRetentionUntil: extendedRetention(until) } : {}),
    })
    .where(
      and(
        eq(hooks.token, token),
        eq(hooks.isStartReservation, true),
        eq(hooks.runId, fromRunId)
      )
    )
    .returning({ hookId: hooks.hookId });
  return moved.length > 0;
}

/**
 * The run's own `createHook()` adopting its reservation of `token`: marks it
 * adopted (so lookups stop answering `HookReservedError`), extends its
 * retention to at least the Hook's (the extension must outlive the Hook's
 * disposal), and returns the reservation's metadata for a Hook that brings
 * none. Returns `undefined` when the run holds no reservation of the token.
 */
export async function adoptStartReservation(
  tx: DrizzleTransaction,
  token: string,
  runId: string,
  hookRetentionUntil: Date | undefined
): Promise<{ metadata: SerializedData | undefined } | undefined> {
  const until = hookRetentionUntil?.toISOString();
  const [row] = await tx
    .update(hooks)
    .set({
      adoptedAt: sql`coalesce(${hooks.adoptedAt}, now())`,
      ...(until ? { tokenRetentionUntil: extendedRetention(until) } : {}),
    })
    .where(
      and(
        eq(hooks.token, token),
        eq(hooks.isStartReservation, true),
        eq(hooks.runId, runId)
      )
    )
    .returning({ metadata: hooks.metadata });
  return row
    ? { metadata: (row.metadata ?? undefined) as SerializedData | undefined }
    : undefined;
}
