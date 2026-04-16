import { parseDurationToDate } from '@workflow/utils';
import type { StructuredError } from '@workflow/world';
import type { StringValue } from 'ms';

const BASE_URL = 'https://workflow-sdk.dev/err';

/**
 * @internal
 * Check if a value is an Error without relying on Node.js utilities.
 * This is needed for error classes that can be used in VM contexts where
 * Node.js imports are not available.
 */
function isError(value: unknown): value is { name: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'message' in value
  );
}

/**
 * @internal
 * All the slugs of the errors used for documentation links.
 */
export const ERROR_SLUGS = {
  NODE_JS_MODULE_IN_WORKFLOW: 'node-js-module-in-workflow',
  START_INVALID_WORKFLOW_FUNCTION: 'start-invalid-workflow-function',
  SERIALIZATION_FAILED: 'serialization-failed',
  WEBHOOK_INVALID_RESPOND_WITH_VALUE: 'webhook-invalid-respond-with-value',
  WEBHOOK_RESPONSE_NOT_SENT: 'webhook-response-not-sent',
  FETCH_IN_WORKFLOW_FUNCTION: 'fetch-in-workflow',
  TIMEOUT_FUNCTIONS_IN_WORKFLOW: 'timeout-in-workflow',
  HOOK_CONFLICT: 'hook-conflict',
  CORRUPTED_EVENT_LOG: 'corrupted-event-log',
  STEP_NOT_REGISTERED: 'step-not-registered',
  WORKFLOW_NOT_REGISTERED: 'workflow-not-registered',
} as const;

type ErrorSlug = (typeof ERROR_SLUGS)[keyof typeof ERROR_SLUGS];

interface WorkflowErrorOptions extends ErrorOptions {
  /**
   * The slug of the error. This will be used to generate a link to the error documentation.
   */
  slug?: ErrorSlug;
}

/**
 * The base class for all Workflow-related errors.
 *
 * This error is thrown by the Workflow SDK when internal operations fail.
 * You can use this class with `instanceof` to catch any Workflow SDK error.
 *
 * @example
 * ```ts
 * try {
 *   await getRun(runId);
 * } catch (error) {
 *   if (error instanceof WorkflowError) {
 *     console.error('Workflow SDK error:', error.message);
 *   }
 * }
 * ```
 */
export class WorkflowError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: WorkflowErrorOptions) {
    const msgDocs = options?.slug
      ? `${message}\n\nLearn more: ${BASE_URL}/${options.slug}`
      : message;
    super(msgDocs, { cause: options?.cause });
    this.cause = options?.cause;

    if (options?.cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }

  static is(value: unknown): value is WorkflowError {
    return isError(value) && value.name === 'WorkflowError';
  }
}

/**
 * Thrown when a world (storage backend) operation fails unexpectedly.
 *
 * This is the catch-all error for world implementations. Specific,
 * well-known failure modes have dedicated error types (e.g.
 * EntityConflictError, RunExpiredError, ThrottleError). This error
 * covers everything else — validation failures, missing entities
 * without a dedicated type, or unexpected HTTP errors from world-vercel.
 */
export class WorkflowWorldError extends WorkflowError {
  status?: number;
  code?: string;
  url?: string;
  /** Retry-After value in seconds, present on 429 and 425 responses */
  retryAfter?: number;

  constructor(
    message: string,
    options?: {
      status?: number;
      url?: string;
      code?: string;
      retryAfter?: number;
      cause?: unknown;
    }
  ) {
    super(message, {
      cause: options?.cause,
    });
    this.name = 'WorkflowWorldError';
    this.status = options?.status;
    this.code = options?.code;
    this.url = options?.url;
    this.retryAfter = options?.retryAfter;
  }

  static is(value: unknown): value is WorkflowWorldError {
    return isError(value) && value.name === 'WorkflowWorldError';
  }
}

/**
 * Thrown when a workflow run fails during execution.
 *
 * This error indicates that the workflow encountered a fatal error and cannot
 * continue. It is thrown when awaiting `run.returnValue` on a run whose status
 * is `'failed'`. The `cause` property contains the underlying error with its
 * message, stack trace, and optional error code.
 *
 * Use the static `WorkflowRunFailedError.is()` method for type-safe checking
 * in catch blocks.
 *
 * @example
 * ```ts
 * import { WorkflowRunFailedError } from "workflow/internal/errors";
 *
 * try {
 *   const result = await run.returnValue;
 * } catch (error) {
 *   if (WorkflowRunFailedError.is(error)) {
 *     console.error(`Run ${error.runId} failed:`, error.cause.message);
 *   }
 * }
 * ```
 */
export class WorkflowRunFailedError extends WorkflowError {
  runId: string;
  declare cause: Error & { code?: string };

  constructor(runId: string, error: StructuredError) {
    // Create a proper Error instance from the StructuredError to set as cause
    // NOTE: custom error types do not get serialized/deserialized. Everything is an Error
    const causeError = new Error(error.message);
    if (error.stack) {
      causeError.stack = error.stack;
    }
    if (error.code) {
      (causeError as any).code = error.code;
    }

    super(`Workflow run "${runId}" failed: ${error.message}`, {
      cause: causeError,
    });
    this.name = 'WorkflowRunFailedError';
    this.runId = runId;
  }

  static is(value: unknown): value is WorkflowRunFailedError {
    return isError(value) && value.name === 'WorkflowRunFailedError';
  }
}

/**
 * Thrown when attempting to get results from an incomplete workflow run.
 *
 * This error occurs when you try to access the result of a workflow
 * that is still running or hasn't completed yet.
 */
export class WorkflowRunNotCompletedError extends WorkflowError {
  runId: string;
  status: string;

  constructor(runId: string, status: string) {
    super(`Workflow run "${runId}" has not completed`, {});
    this.name = 'WorkflowRunNotCompletedError';
    this.runId = runId;
    this.status = status;
  }

  static is(value: unknown): value is WorkflowRunNotCompletedError {
    return isError(value) && value.name === 'WorkflowRunNotCompletedError';
  }
}

/**
 * Thrown when the Workflow runtime encounters an internal error.
 *
 * This error indicates an issue with workflow execution, such as
 * serialization failures, starting an invalid workflow function, or
 * other runtime problems.
 */
export class WorkflowRuntimeError extends WorkflowError {
  constructor(message: string, options?: WorkflowErrorOptions) {
    super(message, {
      ...options,
    });
    this.name = 'WorkflowRuntimeError';
  }

  static is(value: unknown): value is WorkflowRuntimeError {
    return isError(value) && value.name === 'WorkflowRuntimeError';
  }
}

/**
 * Thrown when a step function is not registered in the current deployment.
 *
 * This is an infrastructure error — not a user code error. It typically means
 * something went wrong with the bundling/build tooling that caused the step
 * to not get built correctly.
 *
 * When this happens, the step fails (like a FatalError) and control is passed back
 * to the workflow function, which can optionally handle the failure gracefully.
 */
export class StepNotRegisteredError extends WorkflowRuntimeError {
  stepName: string;

  constructor(stepName: string) {
    super(
      `Step "${stepName}" is not registered in the current deployment. This usually indicates a build or bundling issue that caused the step to not be included in the deployment.`,
      { slug: ERROR_SLUGS.STEP_NOT_REGISTERED }
    );
    this.name = 'StepNotRegisteredError';
    this.stepName = stepName;
  }

  static is(value: unknown): value is StepNotRegisteredError {
    return isError(value) && value.name === 'StepNotRegisteredError';
  }
}

/**
 * Thrown when a workflow function is not registered in the current deployment.
 *
 * This is an infrastructure error — not a user code error. It typically means:
 * - A run was started against a deployment that does not have the workflow
 *   (e.g., the workflow was renamed or moved and a new run targeted the latest deployment)
 * - Something went wrong with the bundling/build tooling that caused the workflow
 *   to not get built correctly
 *
 * When this happens, the run fails with a `RUNTIME_ERROR` error code.
 */
export class WorkflowNotRegisteredError extends WorkflowRuntimeError {
  workflowName: string;

  constructor(workflowName: string) {
    super(
      `Workflow "${workflowName}" is not registered in the current deployment. This usually means a run was started against a deployment that does not have this workflow, or there was a build/bundling issue.`,
      { slug: ERROR_SLUGS.WORKFLOW_NOT_REGISTERED }
    );
    this.name = 'WorkflowNotRegisteredError';
    this.workflowName = workflowName;
  }

  static is(value: unknown): value is WorkflowNotRegisteredError {
    return isError(value) && value.name === 'WorkflowNotRegisteredError';
  }
}

/**
 * Thrown when performing operations on a workflow run that does not exist.
 *
 * This error occurs when you call methods on a run object (e.g. `run.status`,
 * `run.cancel()`, `run.returnValue`) but the underlying run ID does not match
 * any known workflow run. Note that `getRun(id)` itself is synchronous and will
 * not throw — this error is raised when subsequent operations discover the run
 * is missing.
 *
 * Use the static `WorkflowRunNotFoundError.is()` method for type-safe checking
 * in catch blocks.
 *
 * @example
 * ```ts
 * import { WorkflowRunNotFoundError } from "workflow/internal/errors";
 *
 * try {
 *   const status = await run.status;
 * } catch (error) {
 *   if (WorkflowRunNotFoundError.is(error)) {
 *     console.error(`Run ${error.runId} does not exist`);
 *   }
 * }
 * ```
 */
export class WorkflowRunNotFoundError extends WorkflowError {
  runId: string;

  constructor(runId: string) {
    super(`Workflow run "${runId}" not found`, {});
    this.name = 'WorkflowRunNotFoundError';
    this.runId = runId;
  }

  static is(value: unknown): value is WorkflowRunNotFoundError {
    return isError(value) && value.name === 'WorkflowRunNotFoundError';
  }
}

/**
 * Thrown when a hook token is already in use by another active workflow run.
 *
 * This is a user error — it means the same custom token was passed to
 * `createHook` in two or more concurrent runs. Use a unique token per run
 * (or omit the token to let the runtime generate one automatically).
 */
export class HookConflictError extends WorkflowError {
  token: string;

  constructor(token: string) {
    super(`Hook token "${token}" is already in use by another workflow`, {
      slug: ERROR_SLUGS.HOOK_CONFLICT,
    });
    this.name = 'HookConflictError';
    this.token = token;
  }

  static is(value: unknown): value is HookConflictError {
    return isError(value) && value.name === 'HookConflictError';
  }
}

/**
 * Thrown when calling `resumeHook()` or `resumeWebhook()` with a token that
 * does not match any active hook.
 *
 * Common causes:
 * - The hook has expired (past its TTL)
 * - The hook was already disposed after being consumed
 * - The workflow has not started yet, so the hook does not exist
 *
 * A common pattern is to catch this error and start a new workflow run when
 * the hook does not exist yet (the "resume or start" pattern).
 *
 * Use the static `HookNotFoundError.is()` method for type-safe checking in
 * catch blocks.
 *
 * @example
 * ```ts
 * import { HookNotFoundError } from "workflow/internal/errors";
 *
 * try {
 *   await resumeHook(token, payload);
 * } catch (error) {
 *   if (HookNotFoundError.is(error)) {
 *     // Hook doesn't exist — start a new workflow run instead
 *     await startWorkflow("myWorkflow", payload);
 *   }
 * }
 * ```
 */
export class HookNotFoundError extends WorkflowError {
  token: string;

  constructor(token: string) {
    super('Hook not found', {});
    this.name = 'HookNotFoundError';
    this.token = token;
  }

  static is(value: unknown): value is HookNotFoundError {
    return isError(value) && value.name === 'HookNotFoundError';
  }
}

/**
 * Thrown when an operation conflicts with the current state of an entity.
 * This includes attempts to modify an entity already in a terminal state,
 * create an entity that already exists, or any other 409-style conflict.
 *
 * The workflow runtime handles this error automatically. Users interacting
 * with world storage backends directly may encounter it.
 */
export class EntityConflictError extends WorkflowWorldError {
  constructor(message: string) {
    super(message);
    this.name = 'EntityConflictError';
  }

  static is(value: unknown): value is EntityConflictError {
    return isError(value) && value.name === 'EntityConflictError';
  }
}

/**
 * Thrown when a run is no longer available — either because it has been
 * cleaned up, expired, or already reached a terminal state (completed/failed).
 *
 * The workflow runtime handles this error automatically. Users interacting
 * with world storage backends directly may encounter it.
 */
export class RunExpiredError extends WorkflowWorldError {
  constructor(message: string) {
    super(message);
    this.name = 'RunExpiredError';
  }

  static is(value: unknown): value is RunExpiredError {
    return isError(value) && value.name === 'RunExpiredError';
  }
}

/**
 * Thrown when an operation cannot proceed because a required timestamp
 * (e.g. retryAfter) has not been reached yet.
 *
 * The workflow runtime handles this error automatically. Users interacting
 * with world storage backends directly may encounter it.
 *
 * @property retryAfter - Delay in seconds before the operation can be retried.
 */
export class TooEarlyError extends WorkflowWorldError {
  constructor(message: string, options?: { retryAfter?: number }) {
    super(message, { retryAfter: options?.retryAfter });
    this.name = 'TooEarlyError';
  }

  static is(value: unknown): value is TooEarlyError {
    return isError(value) && value.name === 'TooEarlyError';
  }
}

/**
 * Thrown when a request is rate limited by the workflow backend.
 *
 * The workflow runtime handles this error automatically with retry logic.
 * Users interacting with world storage backends directly may encounter it
 * if retries are exhausted.
 *
 * @property retryAfter - Delay in seconds before the request can be retried.
 */
export class ThrottleError extends WorkflowWorldError {
  retryAfter?: number;

  constructor(message: string, options?: { retryAfter?: number }) {
    super(message);
    this.name = 'ThrottleError';
    this.retryAfter = options?.retryAfter;
  }

  static is(value: unknown): value is ThrottleError {
    return isError(value) && value.name === 'ThrottleError';
  }
}

/**
 * Thrown when awaiting `run.returnValue` on a workflow run that was cancelled.
 *
 * This error indicates that the workflow was explicitly cancelled (via
 * `run.cancel()`) and will not produce a return value. You can check for
 * cancellation before awaiting the return value by inspecting `run.status`.
 *
 * Use the static `WorkflowRunCancelledError.is()` method for type-safe
 * checking in catch blocks.
 *
 * @example
 * ```ts
 * import { WorkflowRunCancelledError } from "workflow/internal/errors";
 *
 * try {
 *   const result = await run.returnValue;
 * } catch (error) {
 *   if (WorkflowRunCancelledError.is(error)) {
 *     console.log(`Run ${error.runId} was cancelled`);
 *   }
 * }
 * ```
 */
export class WorkflowRunCancelledError extends WorkflowError {
  runId: string;

  constructor(runId: string) {
    super(`Workflow run "${runId}" cancelled`, {});
    this.name = 'WorkflowRunCancelledError';
    this.runId = runId;
  }

  static is(value: unknown): value is WorkflowRunCancelledError {
    return isError(value) && value.name === 'WorkflowRunCancelledError';
  }
}

/**
 * Thrown when attempting to operate on a workflow run that requires a newer World version.
 *
 * This error occurs when a run was created with a newer spec version than the
 * current World implementation supports. To resolve this, upgrade your
 * `workflow` packages to a version that supports the required spec version.
 *
 * Use the static `RunNotSupportedError.is()` method for type-safe checking in
 * catch blocks.
 *
 * @example
 * ```ts
 * import { RunNotSupportedError } from "workflow/internal/errors";
 *
 * try {
 *   const status = await run.status;
 * } catch (error) {
 *   if (RunNotSupportedError.is(error)) {
 *     console.error(
 *       `Run requires spec v${error.runSpecVersion}, ` +
 *       `but world supports v${error.worldSpecVersion}`
 *     );
 *   }
 * }
 * ```
 */
export class RunNotSupportedError extends WorkflowError {
  readonly runSpecVersion: number;
  readonly worldSpecVersion: number;

  constructor(runSpecVersion: number, worldSpecVersion: number) {
    super(
      `Run requires spec version ${runSpecVersion}, but world supports version ${worldSpecVersion}. ` +
        `Please upgrade 'workflow' package.`
    );
    this.name = 'RunNotSupportedError';
    this.runSpecVersion = runSpecVersion;
    this.worldSpecVersion = worldSpecVersion;
  }

  static is(value: unknown): value is RunNotSupportedError {
    return isError(value) && value.name === 'RunNotSupportedError';
  }
}

/**
 * A fatal error is an error that cannot be retried.
 * It will cause the step to fail and the error will
 * be bubbled up to the workflow logic.
 */
export class FatalError extends Error {
  fatal = true;

  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }

  static is(value: unknown): value is FatalError {
    return isError(value) && value.name === 'FatalError';
  }
}

export interface RetryableErrorOptions {
  /**
   * The number of milliseconds to wait before retrying the step.
   * Can also be a duration string (e.g., "5s", "2m") or a Date object.
   * If not provided, the step will be retried after 1 second (1000 milliseconds).
   */
  retryAfter?: number | StringValue | Date;
}

/**
 * An error that can happen during a step execution, allowing
 * for configuration of the retry behavior.
 */
export class RetryableError extends Error {
  /**
   * The Date when the step should be retried.
   */
  retryAfter: Date;

  constructor(message: string, options: RetryableErrorOptions = {}) {
    super(message);
    this.name = 'RetryableError';

    if (options.retryAfter !== undefined) {
      this.retryAfter = parseDurationToDate(options.retryAfter);
    } else {
      // Default to 1 second (1000 milliseconds)
      this.retryAfter = new Date(Date.now() + 1000);
    }
  }

  static is(value: unknown): value is RetryableError {
    return isError(value) && value.name === 'RetryableError';
  }
}

export const VERCEL_403_ERROR_MESSAGE =
  'Your current vercel account does not have access to this resource. Use `vercel login` or `vercel switch` to ensure you are linked to the right account.';

export { RUN_ERROR_CODES, type RunErrorCode } from './error-codes.js';
