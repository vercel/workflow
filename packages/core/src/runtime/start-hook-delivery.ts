import {
  HookConflictError,
  START_HOOK_ADMISSION_REJECTED,
  WorkflowWorldError,
} from '@workflow/errors';
import type { RunInput } from '@workflow/world';
import { runtimeLogger } from '../logger.js';

/**
 * Whether a delivery may take the turbo fast path for this `runInput`. The
 * queued copy of a `start({ hook })` candidate may be refused by the
 * `run_started` it writes, so nothing of its may run before that write
 * returns: turbo, which backgrounds `run_started` and starts inline step
 * bodies first, is off for it on every engine.
 */
export function admitsTurboStart(runInput: RunInput | undefined): boolean {
  return runInput?.startHook === undefined;
}

/**
 * The queued copy of a `start({ hook })` candidate the World refused: another
 * run owns the token (`HookConflictError`), or the World will never admit the
 * request (`START_HOOK_ADMISSION_REJECTED`). Nothing of the candidate ran and
 * it never becomes a run, so the delivery acknowledges. Returns whether it
 * did; every other error, including the rest of `WorkflowWorldError`, is left
 * to the caller's ordinary handling.
 */
export function ackRefusedStartHookCandidate(
  err: unknown,
  runInput: RunInput | undefined,
  runId: string
): boolean {
  if (runInput?.startHook === undefined) return false;
  if (HookConflictError.is(err)) {
    runtimeLogger.info(
      'Start Hook candidate refused: another run owns the token, skipping',
      { workflowRunId: runId, conflictingRunId: err.conflictingRunId }
    );
    return true;
  }
  if (
    WorkflowWorldError.is(err) &&
    err.code === START_HOOK_ADMISSION_REJECTED
  ) {
    runtimeLogger.error(
      'Start Hook candidate permanently rejected by the World, skipping',
      { workflowRunId: runId, error: err.message }
    );
    return true;
  }
  return false;
}
