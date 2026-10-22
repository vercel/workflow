/**
 * Atomic start Hook admission for the sim store: the token constraint table,
 * the immutable decision per candidate, and the orphan fence.
 *
 * The contract is `start-hook.ts` in `@workflow/world`. The shape follows
 * workflow-server's design (`docs/atomic-start-hook.md` there), in its
 * **cross-region** form, because that is the one with a window in it: the
 * claim and the accepted decision commit together, then the run row commits
 * separately, under a check that the candidate has not been fenced. A writer
 * that dies between the two leaves an accepted candidate with no run, which is
 * the orphan the 24-hour bound exists for. The same-region form is that
 * window closed, so a scenario gets it by not stopping there.
 *
 * The window is a checkpoint (`start-hook:accepted`) the store awaits through
 * `SimStoreOptions.checkpoint`, which the world facade turns into a call point:
 * a script can hold a writer there, or kill it.
 *
 * Everything else here is synchronous, so each half is atomic the way one
 * DynamoDB transaction is.
 */

import {
  HookConflictError,
  HookReservedError,
  START_HOOK_ADMISSION_REJECTED,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  HOOK_RESERVED_RETRY_AFTER_SECONDS,
  isTerminalWorkflowRunStatus,
  START_HOOK_CANDIDATE_MAX_AGE_MS,
  type StartHook,
  ulidToDate,
  type WorkflowRun,
} from '@workflow/world';

/** The longest retention a start Hook may ask for (workflow-server's cap). */
export const START_HOOK_RETENTION_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/** Checkpoint name for the cross-region window; see the module doc. */
export const START_HOOK_ACCEPTED_CHECKPOINT = 'start-hook:accepted';

/**
 * The token constraint: who owns a token that no live Hook entity explains
 * on its own.
 *
 * Two kinds. A **reservation** is a `start({ hook })` claim: it outlives its
 * Hook, holding the token until its run has ended and its retention has
 * passed, and the run's own `createHook()` adopts it by filling in `hookId`.
 * A **retained** claim is an ordinary Hook created with a retention, kept so
 * the token stays unavailable after the Hook is gone.
 */
export interface TokenClaim {
  token: string;
  /** The run that owns the token. A force claim re-points it. */
  runId: string;
  reservation: boolean;
  /**
   * The Hook materializing the claim: the adopting (or force-claiming) Hook
   * of a reservation, or the retained Hook. Absent for a reservation its run
   * has not adopted.
   */
  hookId?: string;
  /** The longest retention the claim has been promised, in ms. */
  retentionUntilMs?: number;
  /** The reservation's Hook metadata, for an adoption that brings none. */
  metadata?: unknown;
}

/** One candidate's immutable admission decision. */
export interface StartHookDecision {
  runId: string;
  token: string;
  decision: 'accepted' | 'rejected';
  /** For a refusal: the run that owned the token when it was decided. */
  conflictingRunId?: string;
  /** Virtual time of the decision. */
  decidedAtMs: number;
}

/** What the store needs from the table's owner. */
export interface StartHookTableDeps {
  now(): number;
  getRun(runId: string): WorkflowRun | undefined;
  /** The run of a live Hook entity, if `hookId` is one. */
  liveHookRun(hookId: string): string | undefined;
  /** The run of the live Hook entity holding `token`, if any. */
  liveTokenOwner(token: string): string | undefined;
  /** Hold point for the cross-region window. */
  checkpoint(
    name: string,
    info: { runId: string; token: string }
  ): Promise<void>;
  /** Trace hook for decisions and releases. */
  note?(message: string): void;
}

export type AdmissionOutcome = 'existing' | 'create';

/** Whether a runId's candidate window is still open at `nowMs`. */
export function candidateTimeMs(runId: string): number | undefined {
  return ulidToDate(runId.replace(/^wrun_/, ''))?.getTime();
}

export function startHookRejected(message: string): WorkflowWorldError {
  return new WorkflowWorldError(message, {
    status: 400,
    code: START_HOOK_ADMISSION_REJECTED,
  });
}

export interface StartHookTable {
  /**
   * Decide (or replay the decision for) a candidate. Resolves `existing` when
   * the candidate's run already exists, `create` when the caller must now
   * create it, synchronously, before anything else can run. Throws
   * `HookConflictError` for a refusal and `START_HOOK_ADMISSION_REJECTED` for
   * a candidate that can never be admitted.
   */
  admit(runId: string, startHook: StartHook): Promise<AdmissionOutcome>;
  /** The claim on a token, whether or not it still holds. */
  claim(token: string): TokenClaim | undefined;
  /** Whether a claim still holds its token at `nowMs`. */
  holds(claim: TokenClaim, nowMs: number): boolean;
  /**
   * Drop a claim that no longer holds, fencing an orphaned candidate so its
   * run can never be created afterwards.
   */
  release(token: string): void;
  /** Install or replace a claim. */
  set(claim: TokenClaim): void;
  /**
   * A by-token lookup that found no live Hook: `HookReservedError` while the
   * token is an unadopted reservation of a run that has not ended.
   */
  assertNotReserved(token: string): void;
  /** Record a decision found in a seeded log (no validation). */
  seedAccepted(runId: string, startHook: StartHook, atMs: number): void;
  /**
   * Who would refuse a new candidate for `token` at `atMs`: the owner's
   * runId, or `undefined` when the token is free. Read-only (no fence).
   */
  probe(token: string, atMs: number): string | undefined;
  decisions(): StartHookDecision[];
  claims(): TokenClaim[];
  fenced(): string[];
}

export function createStartHookTable(deps: StartHookTableDeps): StartHookTable {
  const claims = new Map<string, TokenClaim>();
  const decisions = new Map<string, StartHookDecision>();
  /** Orphaned candidates whose run may never be created. */
  const fences = new Set<string>();

  function holds(claim: TokenClaim, nowMs: number): boolean {
    if (claim.hookId && deps.liveHookRun(claim.hookId) === claim.runId) {
      return true;
    }
    const run = deps.getRun(claim.runId);
    if (claim.reservation) {
      if (!run) {
        // Accepted, run not created. Its creation may still be in flight
        // until the candidate's window closes.
        if (fences.has(claim.runId)) return false;
        const born = candidateTimeMs(claim.runId);
        return (
          born !== undefined && nowMs - born <= START_HOOK_CANDIDATE_MAX_AGE_MS
        );
      }
      if (!isTerminalWorkflowRunStatus(run.status)) return true;
    }
    return (claim.retentionUntilMs ?? 0) > nowMs;
  }

  /** The live owner of a token, after any claim that no longer holds is gone. */
  function holderOf(
    token: string,
    nowMs: number,
    liveHookOwner: string | undefined
  ): string | undefined {
    if (liveHookOwner) return liveHookOwner;
    const claim = claims.get(token);
    if (!claim) return undefined;
    return holds(claim, nowMs) ? claim.runId : undefined;
  }

  function release(token: string): void {
    const claim = claims.get(token);
    if (!claim) return;
    if (claim.reservation && !deps.getRun(claim.runId)) {
      // The release's first write, in the candidate's own region: from here
      // on its run row can never land (row 9, "fence D if D has no run row").
      fences.add(claim.runId);
      deps.note?.(
        `start hook: fenced orphaned candidate ${claim.runId} and released token "${token}"`
      );
    }
    claims.delete(token);
  }

  const table: StartHookTable = {
    async admit(runId, startHook) {
      const { token } = startHook;
      const now = deps.now();

      // Row 0, before any read: a candidate past its window can never be
      // created, whatever was decided for it.
      const born = candidateTimeMs(runId);
      if (born === undefined || now - born > START_HOOK_CANDIDATE_MAX_AGE_MS) {
        throw startHookRejected(
          `Workflow run "${runId}" is too old to be admitted with a start Hook`
        );
      }
      if (
        startHook.tokenRetentionUntil !== undefined &&
        startHook.tokenRetentionUntil.getTime() >
          now + START_HOOK_RETENTION_LIMIT_MS
      ) {
        throw startHookRejected(
          'Hook minimum retention cannot exceed 30 days in the Sim World.'
        );
      }

      const existingRun = deps.getRun(runId);
      const decided = decisions.get(runId);
      if (decided) {
        if (decided.token !== token) {
          throw startHookRejected(
            `Workflow run "${runId}" was already decided for a different start Hook token`
          );
        }
        if (decided.decision === 'rejected') {
          throw new HookConflictError(token, decided.conflictingRunId);
        }
        if (existingRun) return 'existing';
        // Rows 4 and 5: accepted, the run row did not land.
        if (fences.has(runId)) {
          throw startHookRejected(
            `Workflow run "${runId}" was fenced as an orphan and can never be created`
          );
        }
        return finishCreation(runId, token);
      }
      if (existingRun) {
        // Row 7: a run this id already names, created without a start Hook.
        throw startHookRejected(
          `Workflow run "${runId}" already exists without this start Hook`
        );
      }

      const owner = holderOf(token, now, deps.liveTokenOwner(token));
      if (owner !== undefined && owner !== runId) {
        decisions.set(runId, {
          runId,
          token,
          decision: 'rejected',
          conflictingRunId: owner,
          decidedAtMs: now,
        });
        throw new HookConflictError(token, owner);
      }
      // Row 9 then row 2: clear a claim that stopped holding, then claim and
      // accept in one write.
      release(token);
      claims.set(token, {
        token,
        runId,
        reservation: true,
        ...(startHook.tokenRetentionUntil
          ? { retentionUntilMs: startHook.tokenRetentionUntil.getTime() }
          : {}),
        ...(startHook.metadata !== undefined
          ? { metadata: startHook.metadata }
          : {}),
      });
      decisions.set(runId, {
        runId,
        token,
        decision: 'accepted',
        decidedAtMs: now,
      });
      return finishCreation(runId, token);
    },

    claim: (token) => claims.get(token),
    holds,
    release,
    set(claim) {
      claims.set(claim.token, claim);
    },

    assertNotReserved(token) {
      const claim = claims.get(token);
      if (!claim?.reservation || claim.hookId !== undefined) return;
      const run = deps.getRun(claim.runId);
      const live = run
        ? !isTerminalWorkflowRunStatus(run.status)
        : holds(claim, deps.now());
      if (live) {
        throw new HookReservedError(token, claim.runId, {
          retryAfter: HOOK_RESERVED_RETRY_AFTER_SECONDS,
        });
      }
    },

    seedAccepted(runId, startHook, atMs) {
      if (decisions.has(runId)) return;
      decisions.set(runId, {
        runId,
        token: startHook.token,
        decision: 'accepted',
        decidedAtMs: atMs,
      });
      if (!claims.has(startHook.token)) {
        claims.set(startHook.token, {
          token: startHook.token,
          runId,
          reservation: true,
          ...(startHook.tokenRetentionUntil
            ? {
                retentionUntilMs: new Date(
                  startHook.tokenRetentionUntil
                ).getTime(),
              }
            : {}),
          ...(startHook.metadata !== undefined
            ? { metadata: startHook.metadata }
            : {}),
        });
      }
    },

    probe(token, atMs) {
      return holderOf(token, atMs, deps.liveTokenOwner(token));
    },

    decisions: () => [...decisions.values()].map((d) => ({ ...d })),
    claims: () => [...claims.values()].map((c) => ({ ...c })),
    fenced: () => [...fences],
  };

  /**
   * The second write: the run row, conditioned on no fence. Awaits the
   * cross-region checkpoint first, so a script can hold or kill the writer
   * between its decision and its run.
   */
  async function finishCreation(
    runId: string,
    token: string
  ): Promise<AdmissionOutcome> {
    await deps.checkpoint(START_HOOK_ACCEPTED_CHECKPOINT, { runId, token });
    // Another attempt for the candidate may have created the run meanwhile.
    if (deps.getRun(runId)) return 'existing';
    if (fences.has(runId)) {
      throw startHookRejected(
        `Workflow run "${runId}" was fenced as an orphan while its creation was in flight`
      );
    }
    return 'create';
  }

  return table;
}
