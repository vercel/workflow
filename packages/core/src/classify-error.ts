import {
  CorruptedEventLogError,
  RUN_ERROR_CODES,
  type RunErrorCode,
  RuntimeDecryptionError,
  StepNotRegisteredError,
  ThrottleError,
  TooEarlyError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';

// Codes that represent a genuine, non-recoverable disagreement about the
// world protocol: the server returned a structurally valid response whose
// *shape* is wrong. Retrying these would replay the same poison response,
// so they fail the run.
//
// `PARSE_ERROR` is deliberately NOT in this set. A parse failure means we
// could not read or decode the response body at all (a truncated/terminated
// stream, a connection reset mid-body, or a gateway returning a 200 with an
// HTML error page). On the Vercel platform these are overwhelmingly transient
// infrastructure blips, so they must propagate to the queue handler for an
// automatic retry rather than permanently failing the run. See
// `isWorldContractError` and its callers in `runtime.ts`.
const WORLD_CONTRACT_ERROR_CODES = new Set([
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
    err.message.startsWith('Schema validation failed for ') ||
    (typeof cause === 'object' &&
      cause !== null &&
      'name' in cause &&
      cause.name === 'ZodError')
  );
}

/**
 * True when an error is a transient infrastructure failure that should
 * propagate to the queue handler for an automatic retry, rather than being
 * recorded as a `run_failed` event.
 *
 * The replay loop loads the event log (`events.list`) and talks to the world
 * on every iteration. When one of those calls fails transiently — a server
 * error, a rate limit, or a failure reading/decoding the response body — the
 * run is not broken; the next queue delivery can simply replay it. Failing
 * the run on such a blip is the bug this guards against.
 *
 * Retryable:
 *  - `ThrottleError` (429) and `TooEarlyError` (425): the backend explicitly
 *    asked us to back off. (These subclass `WorkflowWorldError` but override
 *    `name`, so the `WorkflowWorldError.is` branch below does not catch them.)
 *  - `WorkflowWorldError` with HTTP 5xx: server-side failure.
 *  - `WorkflowWorldError` with no HTTP status that is not a contract error:
 *    a response-body parse failure (`PARSE_ERROR`) — truncated/terminated
 *    stream, connection reset, or a gateway returning a non-CBOR/JSON body.
 *
 * Not retryable (these fall through to `run_failed`):
 *  - World *contract* violations (schema validation): a well-formed response
 *    of the wrong shape — replaying yields the same poison response.
 *  - Client errors (4xx other than 425/429): the request itself is wrong.
 *  - User-code errors, `WorkflowRuntimeError`, corrupted event logs.
 */
export function isRetryableWorldError(err: unknown): boolean {
  if (ThrottleError.is(err) || TooEarlyError.is(err)) {
    return true;
  }
  if (!WorkflowWorldError.is(err)) {
    return false;
  }
  // Read `status` while `err` is still narrowed to WorkflowWorldError.
  // `isWorldContractError` is an `err is WorkflowWorldError` guard, so its
  // negative branch would narrow `err` to `never` and lose `.status`.
  const status = err.status;
  if (isWorldContractError(err)) {
    return false;
  }
  // A WorkflowWorldError that is not a contract violation: retry on a server
  // error (5xx) or a status-less response-body parse failure.
  return status === undefined || status >= 500;
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
