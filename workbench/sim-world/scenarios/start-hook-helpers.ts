/**
 * Shared moves for the start Hook scenarios. Not a scenario.
 */

import type {
  CallContext,
  CallMatch,
  ResumeOutcome,
  ScenarioSpec,
  StartOutcome,
  Tempo,
} from '@workflow/world-sim';

/** World flags every start Hook scenario shares. */
export const startHookWorld = {
  startHooks: true,
  startedBy: 'script',
} as const satisfies Partial<ScenarioSpec>;

/**
 * The same scenario with the sim's optimistic-concurrency fence armed (both
 * halves), under its own id.
 */
export function fenced(spec: ScenarioSpec): ScenarioSpec {
  return {
    ...spec,
    id: `${spec.id}-fenced`,
    name: `${spec.name} (fence armed)`,
    preconditionGuard: true,
  };
}

/**
 * Resume a start Hook token the way a caller that respects
 * `HookReservedError` would: while the owner has not adopted its
 * reservation, wait for the owner's next committed write and ask again.
 * Waiting on the owner's progress rather than on a clock keeps it
 * deterministic, and it is the tightest retry loop there is.
 */
export async function resumeOnceAdopted(
  sim: Tempo,
  token: string,
  payload: unknown,
  attempts = 20
): Promise<ResumeOutcome> {
  let last: ResumeOutcome = { kind: 'not-found' };
  for (let i = 0; i < attempts; i++) {
    last = await sim.resume(token, payload);
    if (last.kind !== 'reserved') return last;
    sim.note(
      `resume "${token}": reserved by ${last.runId}, retrying once it moves`
    );
    // Adopted between the answer and now: ask again straight away.
    if (sim.world.hooks().some((h) => h.token === token)) continue;
    await sim.until(
      { call: 'events.create', runId: last.runId, failed: false },
      `${last.runId} moves`
    );
  }
  return last;
}

/** The run a start answered with, or the owner it named. */
export function ownerOf(outcome: StartOutcome): string | undefined {
  if (outcome.kind === 'run') return outcome.runId;
  if (outcome.kind === 'conflict') return outcome.conflictingRunId;
  return undefined;
}

/** The pending message for a run, by runId. */
export function messageFor(runId: string) {
  return (pending: { messageId: string; runId?: string }[]) =>
    pending.find((m) => m.runId === runId)?.messageId;
}

/**
 * How many times `start()` posts one candidate's `run_created` before it
 * throws `WorkflowStartError`: once, then its in-place confirmations
 * (`START_HOOK_CONFIRM_DELAYS_MS` in `@workflow/core`).
 */
export const START_HOOK_POSTS_PER_CANDIDATE = 4;

/**
 * Lose the response of the next `count` matching calls, one after another,
 * so a start that confirms in place stays uncertain. Resolves with the first
 * call's context.
 */
export async function loseResponses(
  sim: Tempo,
  match: CallMatch,
  count = START_HOOK_POSTS_PER_CANDIDATE
): Promise<CallContext> {
  const first = await sim.fault.loseResponse(match);
  for (let i = 1; i < count; i++) await sim.fault.loseResponse(match);
  return first;
}
