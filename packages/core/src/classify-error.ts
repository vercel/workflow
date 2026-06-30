import {
  CorruptedEventLogError,
  ReplayDivergenceError,
  RUN_ERROR_CODES,
  type RunErrorCode,
  RuntimeDecryptionError,
  StepNotRegisteredError,
  ThrottleError,
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
 * `WorkflowWorldError.code` values that mark a transient transport failure
 * (set by world-vercel's HTTP client): `TRANSPORT` covers an exhausted
 * RetryAgent (`UND_ERR_REQ_RETRY` — e.g. the firewall in front of
 * workflow-server shedding load with 429/503), a dropped socket, or a
 * connect/DNS failure; `TIMEOUT` covers a request that exceeded the client
 * timeout. Both are infrastructure failures a fresh invocation can recover
 * from. Kept distinct from `WORLD_CONTRACT_ERROR_CODES` so a transport blip is
 * never misclassified as the server returning a malformed response.
 */
const RETRYABLE_WORLD_ERROR_CODES = new Set(['TRANSPORT', 'TIMEOUT']);

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

/**
 * True when an error from a world (workflow-server) call is a transient
 * infrastructure failure that should be retried by redelivering the queue
 * message, rather than failing the run. A fresh invocation will likely
 * succeed once the backend (or the firewall in front of it) recovers.
 *
 * - `ThrottleError` (429): rate limited / load shed
 * - `WorkflowWorldError` with `status >= 500`: server-side error
 * - `WorkflowWorldError` with a retryable transport `code` (`TRANSPORT` /
 *   `TIMEOUT`): the request never produced a usable response
 *
 * Uses `.is()` name-based duck checks (not `instanceof`) for the same
 * cross-`vm`-realm reason described on `classifyRunError`.
 */
export function isRetryableWorldError(err: unknown): boolean {
  if (ThrottleError.is(err)) {
    return true;
  }
  if (!WorkflowWorldError.is(err)) {
    return false;
  }
  if (err.status !== undefined && err.status >= 500) {
    return true;
  }
  return err.code !== undefined && RETRYABLE_WORLD_ERROR_CODES.has(err.code);
}

export function classifyRunError(err: unknown): RunErrorCode {
  if (ReplayDivergenceError.is(err)) {
    return RUN_ERROR_CODES.REPLAY_DIVERGENCE;
  }

  if (CorruptedEventLogError.is(err)) {
    return RUN_ERROR_CODES.CORRUPTED_EVENT_LOG;
  }

  // World-layer faults — both a malformed response (contract violation) and a
  // transient infrastructure failure (throttle / 5xx / transport / timeout,
  // e.g. a firewall challenge) — are the backend's fault, not the user's.
  // Bucket them under WORLD_CONTRACT_ERROR rather than USER_ERROR so dashboards
  // attribute an outage correctly. Note the retryable variants are normally
  // redelivered via the queue (see `isRetryableWorldError`) and only reach this
  // terminal classification if the run ultimately gives up.
  if (isWorldContractError(err) || isRetryableWorldError(err)) {
    return RUN_ERROR_CODES.WORLD_CONTRACT_ERROR;
  }

  for (const isMatch of RUNTIME_ERROR_CHECKS) {
    if (isMatch(err)) {
      return RUN_ERROR_CODES.RUNTIME_ERROR;
    }
  }
  return RUN_ERROR_CODES.USER_ERROR;
}
