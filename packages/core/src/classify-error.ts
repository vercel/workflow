import {
  type RunErrorCode,
  RUN_ERROR_CODES,
  WorkflowRuntimeError,
} from '@workflow/errors';

/**
 * Classify an error that caused a workflow run to fail.
 *
 * After the structural separation of infrastructure vs user code error
 * handling, the only errors that reach the `run_failed` try/catch are:
 * - User code errors (throws from workflow functions, propagated step failures)
 * - WorkflowRuntimeError and subclasses (corrupted event log, missing
 *   timestamps, workflow/step not registered, etc.)
 */
export function classifyRunError(err: unknown): RunErrorCode {
  if (err instanceof WorkflowRuntimeError) {
    return RUN_ERROR_CODES.RUNTIME_ERROR;
  }
  return RUN_ERROR_CODES.USER_ERROR;
}
