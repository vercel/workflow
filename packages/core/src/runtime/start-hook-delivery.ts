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

/**
 * A `run_started` answered without its `run`: the response failed its schema
 * at `run`, and only there. It is a contract violation (the World must return
 * the run it started), but a backend has produced it transiently, for a
 * resilient `run_started` that overtook the `run_created` still being written
 * by `start()`, which the queue-first order of `start({ hook })` makes
 * reachable. A redelivery finds the run whole, so the delivery retries
 * instead of failing the run. Every other schema violation stays fatal.
 */
export function isRunlessRunStartedResponse(err: unknown): boolean {
  if (!WorkflowWorldError.is(err) || err.status !== undefined) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (
    typeof cause !== 'object' ||
    cause === null ||
    (cause as { name?: unknown }).name !== 'ZodError'
  ) {
    return false;
  }
  const issues = (cause as { issues?: unknown }).issues;
  return (
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every(
      (issue) =>
        typeof issue === 'object' &&
        issue !== null &&
        issue.code === 'invalid_type' &&
        Array.isArray(issue.path) &&
        issue.path.length === 1 &&
        issue.path[0] === 'run'
    )
  );
}

/**
 * Setup's check before recording a fatal run error: a run-less `run_started`
 * response is retried by redelivery (the caller rethrows), with a warning.
 * Returns whether it applied.
 */
export function retriesRunlessRunStarted(err: unknown, runId: string): boolean {
  if (!isRunlessRunStartedResponse(err)) return false;
  runtimeLogger.warn(
    'run_started was answered without the run; retrying the delivery instead of failing the run',
    { workflowRunId: runId, error: (err as Error).message }
  );
  return true;
}
