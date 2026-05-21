import {
  CorruptedEventLogError,
  RUN_ERROR_CODES,
  type RunErrorCode,
  SerializationError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { classifyRunError } from './classify-error.js';
import {
  NotInStepContextError,
  NotInWorkflowContextError,
  NotInWorkflowOrStepContextError,
  UnavailableInWorkflowContextError,
} from './context-errors.js';

/**
 * Attribution of a workflow/step failure for presentation.
 *
 * - `user`: the error came from customer code (a step or workflow function
 *   threw, or a value they passed across a boundary wasn't serializable).
 * - `sdk`: the SDK produced the error itself — an internal invariant broke,
 *   or a runtime guard rejected the call. These should be rare; when they
 *   happen we want to frame the terminal output as "this is us, not you."
 */
export type ErrorAttribution = 'user' | 'sdk';

export interface ErrorDescription {
  attribution: ErrorAttribution;
  errorCode: RunErrorCode;
  /**
   * Short, class-aware hint to help a user understand what the error means.
   * Only set for well-known SDK error classes (SerializationError,
   * WorkflowRuntimeError, context-violation errors); `undefined` for plain
   * user errors, where the stack is already the most useful thing to show.
   */
  hint?: string;
}

/**
 * Error signal fields carried on persisted failure events (e.g.
 * `run_failed` / `step_failed`). The shape is intentionally loose:
 *
 * - `errorCode` is typed as `string` rather than `RunErrorCode` because
 *   the value comes from stored JSON/CBOR and may predate the current
 *   enum — callers should not narrow on it blindly. Values that don't
 *   match a known `RUN_ERROR_CODES` entry fall through to USER_ERROR.
 * - `errorName` is the thrown `Error#name`. It is not universally
 *   persisted today; callers that have access to it (either via an
 *   in-memory throw or a richer payload) can pass it in to sharpen
 *   the attribution and hint. When absent, `describeRunError` still
 *   returns a sensible attribution from `errorCode` alone.
 */
export interface PersistedErrorSignal {
  errorCode?: string;
  errorName?: string;
}

const CONTEXT_ERROR_NAMES = new Set([
  'NotInWorkflowContextError',
  'NotInStepContextError',
  'NotInWorkflowOrStepContextError',
  'UnavailableInWorkflowContextError',
]);

function isContextViolationError(err: unknown): boolean {
  return (
    err instanceof NotInWorkflowContextError ||
    err instanceof NotInStepContextError ||
    err instanceof NotInWorkflowOrStepContextError ||
    err instanceof UnavailableInWorkflowContextError
  );
}

const SERIALIZATION_ERROR_HINT =
  'A value passed across a workflow/step boundary could not be serialized. See the error message for the offending path and the Learn More link for details.';
const CONTEXT_ERROR_HINT =
  'A workflow-only or step-only API was called from the wrong context. The error message includes the exact API and how to move the call.';
const RUNTIME_ERROR_HINT =
  'This is an internal workflow SDK error, not a bug in your code. If it keeps happening, please report it with the stack trace and the runId.';
const CORRUPTED_EVENT_LOG_HINT =
  'The workflow event log contains orphaned or mismatched events and cannot be replayed. This is an internal workflow SDK error; please report it with the runId.';
const REPLAY_TIMEOUT_HINT =
  'The workflow replay between step boundaries took too long. This bounds workflow-VM and event-log replay time only — step bodies (`"use step"` functions) are excluded. This usually means the event log is unusually large or the workflow function is doing heavy synchronous work in workflow code outside of step bodies. Override the default budget via the WORKFLOW_REPLAY_TIMEOUT_MS env var if needed.';
const MAX_DELIVERIES_HINT =
  'The workflow queue exceeded its max-delivery budget. This usually indicates a persistent runtime failure — check the most recent stack traces for the underlying cause.';
const WORLD_CONTRACT_HINT =
  'The workflow backend returned data that violated the SDK contract. This is not retryable; please report it with the stack trace and runId.';

function normalizeErrorCode(code: string | undefined): RunErrorCode {
  // Values read back from persisted events are `string | undefined` — we
  // only trust codes that match a known entry in `RUN_ERROR_CODES`.
  const known = Object.values(RUN_ERROR_CODES) as readonly string[];
  if (code && known.includes(code)) {
    return code as RunErrorCode;
  }
  return RUN_ERROR_CODES.USER_ERROR;
}

/**
 * Data-driven variant of {@link describeError} that works from persisted
 * event fields instead of a live `Error` instance. Intended for CLI/web
 * renderers that read failure events and no longer have the original
 * thrown object.
 */
export function describeRunError(
  signal: PersistedErrorSignal
): ErrorDescription {
  const name = signal.errorName;
  const errorCode =
    name === 'CorruptedEventLogError'
      ? RUN_ERROR_CODES.CORRUPTED_EVENT_LOG
      : normalizeErrorCode(signal.errorCode);

  if (name === 'SerializationError') {
    return { attribution: 'user', errorCode, hint: SERIALIZATION_ERROR_HINT };
  }
  if (name && CONTEXT_ERROR_NAMES.has(name)) {
    return { attribution: 'user', errorCode, hint: CONTEXT_ERROR_HINT };
  }
  if (name === 'CorruptedEventLogError') {
    return {
      attribution: 'sdk',
      errorCode,
      hint: CORRUPTED_EVENT_LOG_HINT,
    };
  }
  if (errorCode === RUN_ERROR_CODES.REPLAY_TIMEOUT) {
    return { attribution: 'sdk', errorCode, hint: REPLAY_TIMEOUT_HINT };
  }
  if (errorCode === RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED) {
    return { attribution: 'sdk', errorCode, hint: MAX_DELIVERIES_HINT };
  }
  if (errorCode === RUN_ERROR_CODES.CORRUPTED_EVENT_LOG) {
    return {
      attribution: 'sdk',
      errorCode,
      hint: CORRUPTED_EVENT_LOG_HINT,
    };
  }
  if (errorCode === RUN_ERROR_CODES.WORLD_CONTRACT_ERROR) {
    return {
      attribution: 'sdk',
      errorCode,
      hint: WORLD_CONTRACT_HINT,
    };
  }
  if (name === 'WorkflowRuntimeError' || name === 'StepNotRegisteredError') {
    return { attribution: 'sdk', errorCode, hint: RUNTIME_ERROR_HINT };
  }
  if (errorCode === RUN_ERROR_CODES.RUNTIME_ERROR) {
    return { attribution: 'sdk', errorCode, hint: RUNTIME_ERROR_HINT };
  }
  return { attribution: 'user', errorCode };
}

/**
 * Describe an error for user-facing presentation. Purely informational —
 * does not change any persisted event data or error classification used by
 * the runtime.
 *
 * The attribution here is more nuanced than `classifyRunError`:
 *
 * - `SerializationError` is technically raised by the SDK, but it almost
 *   always points at something the caller did (passed a non-serializable
 *   value, didn't register a class). We attribute it to the user.
 * - Context-violation errors (`NotInWorkflowContextError`, etc.) likewise
 *   describe a user mistake.
 * - `WorkflowRuntimeError` (and subclasses like `StepNotRegisteredError`)
 *   indicates an internal SDK invariant broke — surface that as `sdk`.
 *
 * @param err The error value thrown by the workflow / step.
 * @param errorCode Optional precomputed error code. Callers that already
 *   know the code (e.g. `REPLAY_TIMEOUT` or `MAX_DELIVERIES_EXCEEDED`, which
 *   `classifyRunError` can't derive from the error alone) should pass it so
 *   the attribution and hint reflect the actual failure category.
 */
export function describeError(
  err: unknown,
  errorCode?: RunErrorCode
): ErrorDescription {
  const effectiveCode = errorCode ?? classifyRunError(err);

  if (SerializationError.is(err)) {
    return {
      attribution: 'user',
      errorCode: effectiveCode,
      hint: SERIALIZATION_ERROR_HINT,
    };
  }

  if (isContextViolationError(err)) {
    return {
      attribution: 'user',
      errorCode: effectiveCode,
      hint: CONTEXT_ERROR_HINT,
    };
  }

  if (CorruptedEventLogError.is(err)) {
    return {
      attribution: 'sdk',
      errorCode: effectiveCode,
      hint: CORRUPTED_EVENT_LOG_HINT,
    };
  }

  if (err instanceof WorkflowRuntimeError) {
    return {
      attribution: 'sdk',
      errorCode: effectiveCode,
      hint: RUNTIME_ERROR_HINT,
    };
  }

  if (effectiveCode === RUN_ERROR_CODES.REPLAY_TIMEOUT) {
    return {
      attribution: 'sdk',
      errorCode: effectiveCode,
      hint: REPLAY_TIMEOUT_HINT,
    };
  }

  if (effectiveCode === RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED) {
    return {
      attribution: 'sdk',
      errorCode: effectiveCode,
      hint: MAX_DELIVERIES_HINT,
    };
  }

  if (effectiveCode === RUN_ERROR_CODES.CORRUPTED_EVENT_LOG) {
    return {
      attribution: 'sdk',
      errorCode: effectiveCode,
      hint: CORRUPTED_EVENT_LOG_HINT,
    };
  }

  if (effectiveCode === RUN_ERROR_CODES.WORLD_CONTRACT_ERROR) {
    return {
      attribution: 'sdk',
      errorCode: effectiveCode,
      hint: WORLD_CONTRACT_HINT,
    };
  }

  return { attribution: 'user', errorCode: effectiveCode };
}
