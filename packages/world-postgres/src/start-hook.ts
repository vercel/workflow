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
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  type DrizzleHandle,
  type DrizzleTransaction,
  Schema,
} from './drizzle/index.js';

/**
 * `start({ hook })` admission for world-postgres. See `start-hook.ts` in
 * @workflow/world for the contract.
 *
 * Every write that can take or check a Hook token for another run (a start
 * admission, a `createHook()`) first takes a transaction-scoped advisory lock
 * on the token, so admissions and Hook creations for one token serialize. The
 * decision and the run it admits commit in one transaction, so an accepted
 * candidate always has its run and no orphan bound has to be enforced on
 * reads: a missing run means the run was deleted, which releases the token.
 */

/** Serializes writers that take or check `token` until the transaction ends. */
export async function lockStartHookToken(
  tx: DrizzleTransaction,
  token: string
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`workflow:hook-token:${token}`}, 0))`
  );
}

/**
 * The run holding an active start reservation of `token`, other than
 * `excludeRunId`. A reservation is active while its holder run exists and is
 * not terminal, or exists and its retention has not passed. A deleted holder
 * releases it.
 */
export async function findActiveStartReservation(
  tx: DrizzleHandle,
  token: string,
  excludeRunId: string
): Promise<string | undefined> {
  const admissions = Schema.startHookAdmissions;
  const holderRun = (live: boolean) =>
    tx
      .select({ runId: Schema.runs.runId })
      .from(Schema.runs)
      .where(
        and(
          eq(Schema.runs.runId, admissions.holderRunId),
          live
            ? notInArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
            : undefined
        )
      );
  const [row] = await tx
    .select({ holderRunId: admissions.holderRunId })
    .from(admissions)
    .where(
      and(
        eq(admissions.token, token),
        eq(admissions.decision, 'accepted'),
        ne(admissions.holderRunId, excludeRunId),
        or(
          exists(holderRun(true)),
          and(
            gt(admissions.tokenRetentionUntil, sql`now()`),
            exists(holderRun(false))
          )
        )
      )
    )
    .limit(1);
  return row?.holderRunId ?? undefined;
}

/** The run owning a live Hook of `token`, other than `excludeRunId`. */
async function findActiveHookOwner(
  tx: DrizzleTransaction,
  token: string,
  excludeRunId: string
): Promise<string | undefined> {
  const hooks = Schema.hooks;
  const ownerRunIsTerminal = tx
    .select({ runId: Schema.runs.runId })
    .from(Schema.runs)
    .where(
      and(
        eq(Schema.runs.runId, hooks.runId),
        inArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
      )
    );
  const [row] = await tx
    .select({ runId: hooks.runId })
    .from(hooks)
    .where(
      and(
        eq(hooks.token, token),
        ne(hooks.runId, excludeRunId),
        or(
          gt(hooks.tokenRetentionUntil, sql`now()`),
          notExists(ownerRunIsTerminal)
        )
      )
    )
    .limit(1);
  return row?.runId;
}

export type StartHookDecision =
  | { decision: 'accepted'; replayed: boolean }
  | { decision: 'rejected'; conflictingRunId: string };

/**
 * Decides admission for candidate `runId` inside the transaction that would
 * create its run. Call {@link lockStartHookToken} first.
 *
 * - A recorded decision is returned as-is (`replayed: true` for an accepted
 *   one, whose run already exists).
 * - A new candidate is accepted when no other run owns the token, recording
 *   `accepted`; the caller then creates the run in the same transaction.
 * - Otherwise it is rejected, recording the owner. The caller must commit the
 *   transaction and then throw {@link startHookConflict}.
 */
export async function decideStartHookAdmission(
  tx: DrizzleTransaction,
  runId: string,
  startHook: StartHook
): Promise<StartHookDecision> {
  const admissions = Schema.startHookAdmissions;
  const [existing] = await tx
    .select()
    .from(admissions)
    .where(eq(admissions.runId, runId))
    .limit(1);
  if (existing) {
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

  // Orphan bound: a candidate this old can never be created (the decision
  // above covers every candidate that was).
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

  const owner =
    (await findActiveHookOwner(tx, startHook.token, runId)) ??
    (await findActiveStartReservation(tx, startHook.token, runId));
  if (owner) {
    await tx.insert(admissions).values({
      runId,
      token: startHook.token,
      decision: 'rejected',
      conflictingRunId: owner,
    });
    return { decision: 'rejected', conflictingRunId: owner };
  }
  await tx.insert(admissions).values({
    runId,
    token: startHook.token,
    decision: 'accepted',
    holderRunId: runId,
    tokenRetentionUntil: startHook.tokenRetentionUntil,
    metadata: startHook.metadata,
  });
  return { decision: 'accepted', replayed: false };
}

/** The refusal a rejected decision answers with, after its commit. */
export function startHookConflict(
  startHook: StartHook,
  conflictingRunId: string
): HookConflictError {
  return new HookConflictError(startHook.token, conflictingRunId);
}

/**
 * Moves the reservation `fromRunId` holds on `token` to `toRunId`. Used by a
 * forced `createHook()` that takes the reservation's materialized Hook: the
 * reservation follows the Hook, so the claimer owns the token until it ends.
 */
export async function transferStartReservation(
  tx: DrizzleTransaction,
  token: string,
  fromRunId: string,
  toRunId: string
): Promise<void> {
  const admissions = Schema.startHookAdmissions;
  await tx
    .update(admissions)
    .set({ holderRunId: toRunId })
    .where(
      and(
        eq(admissions.token, token),
        eq(admissions.decision, 'accepted'),
        eq(admissions.holderRunId, fromRunId)
      )
    );
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
  const admissions = Schema.startHookAdmissions;
  const until = hookRetentionUntil?.toISOString();
  const [row] = await tx
    .update(admissions)
    .set({
      adoptedAt: sql`coalesce(${admissions.adoptedAt}, now())`,
      ...(until
        ? {
            tokenRetentionUntil: sql`greatest(coalesce(${admissions.tokenRetentionUntil}, ${until}::timestamptz), ${until}::timestamptz)`,
          }
        : {}),
    })
    .where(
      and(
        eq(admissions.token, token),
        eq(admissions.decision, 'accepted'),
        eq(admissions.holderRunId, runId)
      )
    )
    .returning({ metadata: admissions.metadata });
  return row ? { metadata: row.metadata ?? undefined } : undefined;
}

/**
 * The run holding an UNADOPTED, live start reservation of `token`: its holder
 * exists, has not ended, and has not created a Hook for it yet.
 */
export async function findUnadoptedStartReservation(
  db: DrizzleHandle,
  token: string
): Promise<string | undefined> {
  const admissions = Schema.startHookAdmissions;
  const [row] = await db
    .select({ holderRunId: admissions.holderRunId })
    .from(admissions)
    .where(
      and(
        eq(admissions.token, token),
        eq(admissions.decision, 'accepted'),
        isNull(admissions.adoptedAt),
        exists(
          db
            .select({ runId: Schema.runs.runId })
            .from(Schema.runs)
            .where(
              and(
                eq(Schema.runs.runId, admissions.holderRunId),
                notInArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
              )
            )
        )
      )
    )
    .limit(1);
  return row?.holderRunId ?? undefined;
}
