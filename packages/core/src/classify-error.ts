import {
  RUN_ERROR_CODES,
  type RunErrorCode,
  StepNotRegisteredError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
} from '@workflow/errors';

/**
 * Set of error names that should classify as `RUNTIME_ERROR`. Each
 * `*.is()` static does a name-based duck check, so subclassing alone is
 * not enough — we have to enumerate every concrete subclass we want to
 * recognize. Keep in sync with the `WorkflowRuntimeError` class hierarchy
 * in `@workflow/errors`.
 */
const RUNTIME_ERROR_CHECKS = [
  WorkflowRuntimeError.is,
  StepNotRegisteredError.is,
  WorkflowNotRegisteredError.is,
];

/**
 * Classify an error that caused a workflow run to fail.
 *
 * After the structural separation of infrastructure vs user code error
 * handling, the only errors that reach the `run_failed` try/catch are:
 * - User code errors (throws from workflow functions, propagated step failures)
 * - WorkflowRuntimeError and subclasses (corrupted event log, missing
 *   timestamps, workflow/step not registered, etc.)
 *
 * Uses each subclass's `.is()` static (a name-based duck check) instead of
 * a single `instanceof` check because workflows execute in a separate
 * `vm` realm: the VM-context `WorkflowRuntimeError` and the host-context
 * one are distinct classes, so `instanceof` returns `false` for any error
 * thrown inside the workflow VM and we'd misclassify genuine runtime
 * errors as user errors.
 */
export function classifyRunError(err: unknown): RunErrorCode {
  for (const isMatch of RUNTIME_ERROR_CHECKS) {
    if (isMatch(err)) {
      return RUN_ERROR_CODES.RUNTIME_ERROR;
    }
  }
  return RUN_ERROR_CODES.USER_ERROR;
}
