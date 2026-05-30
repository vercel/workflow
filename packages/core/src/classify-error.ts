import {
  CorruptedEventLogError,
  RUN_ERROR_CODES,
  type RunErrorCode,
  RuntimeDecryptionError,
  StepNotRegisteredError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';

const WORLD_CONTRACT_ERROR_CODES = new Set([
  'PARSE_ERROR',
  'SCHEMA_VALIDATION',
  RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
]);

/**
 * Set of error names that should classify as generic `RUNTIME_ERROR`. Each
 * `*.is()` static does a name-based duck check, so subclassing alone is
 * not enough — we have to enumerate every concrete subclass we want to
 * recognize. Keep in sync with the `WorkflowRuntimeError` class hierarchy
 * in `@workflow/errors`.
 */
const RUNTIME_ERROR_CHECKS = [
  WorkflowRuntimeError.is,
  StepNotRegisteredError.is,
  WorkflowNotRegisteredError.is,
  // SDK-level encryption failures (most notably AES-GCM auth-tag
  // mismatches surfacing as a native `OperationError` from
  // `AESCipherJob.onDone`) are wrapped in `RuntimeDecryptionError` at
  // the encryption module boundary.
  RuntimeDecryptionError.is,
];

/**
 * Classify an error that caused a workflow run to fail.
 *
 * After the structural separation of infrastructure vs user code error
 * handling, the only errors that reach the `run_failed` try/catch are:
 * - User code errors (throws from workflow functions, propagated step failures)
 * - WorkflowRuntimeError and subclasses (missing timestamps, workflow/step
 *   not registered, corrupted event log, etc.)
 *
 * Uses each subclass's `.is()` static (a name-based duck check) instead of
 * a single `instanceof` check because workflows execute in a separate
 * `vm` realm: the VM-context `WorkflowRuntimeError` and the host-context
 * one are distinct classes, so `instanceof` returns `false` for any error
 * thrown inside the workflow VM and we'd misclassify genuine runtime
 * errors as user errors.
 */
export function isWorldContractError(err: unknown): err is WorkflowWorldError {
  if (!WorkflowWorldError.is(err) || err.status !== undefined) {
    return false;
  }

  const cause = 'cause' in err ? err.cause : undefined;
  return (
    (err.code !== undefined && WORLD_CONTRACT_ERROR_CODES.has(err.code)) ||
    err.message.startsWith('Failed to parse response body for ') ||
    err.message.startsWith('Schema validation failed for ') ||
    (typeof cause === 'object' &&
      cause !== null &&
      'name' in cause &&
      cause.name === 'ZodError')
  );
}

export function classifyRunError(err: unknown): RunErrorCode {
  if (CorruptedEventLogError.is(err)) {
    return RUN_ERROR_CODES.CORRUPTED_EVENT_LOG;
  }

  if (isWorldContractError(err)) {
    return RUN_ERROR_CODES.WORLD_CONTRACT_ERROR;
  }

  for (const isMatch of RUNTIME_ERROR_CHECKS) {
    if (isMatch(err)) {
      return RUN_ERROR_CODES.RUNTIME_ERROR;
    }
  }
  return RUN_ERROR_CODES.USER_ERROR;
}
