import { parseDurationToDate } from '@workflow/utils';
import type { StructuredError } from '@workflow/world';
import type { StringValue } from 'ms';

const BASE_URL = 'https://useworkflow.dev/err';

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
 * This error is thrown by the Workflow DevKit when internal operations fail.
 * You can use this class with `instanceof` to catch any Workflow DevKit error.
 *
 * @example
 * ```ts
 * try {
 *   await getRun(runId);
 * } catch (error) {
 *   if (error instanceof WorkflowError) {
 *     console.error('Workflow DevKit error:', error.message);
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
  /** Retry-After value in seconds, present on 429 responses */
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
 * This error indicates that the workflow encountered a fatal error
 * and cannot continue. The `cause` property contains the underlying
 * error with its message, stack trace, and optional error code.
 *
 * @example
 * ```
 * const run = await getRun(runId);
 * if (run.status === 'failed') {
 *   // WorkflowRunFailedError will be thrown
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
    super(
      `Hook token "${token}" is already in use by another workflow`,
      { slug: ERROR_SLUGS.HOOK_CONFLICT }
    );
    this.name = 'HookConflictError';
    this.token = token;
  }

  static is(value: unknown): value is HookConflictError {
    return isError(value) && value.name === 'HookConflictError';
  }
}

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
 */
export class EntityConflictError extends WorkflowError {
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
 */
export class RunExpiredError extends WorkflowError {
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
 */
export class TooEarlyError extends WorkflowError {
  retryAfter?: Date;

  constructor(message: string, options?: { retryAfter?: Date }) {
    super(message);
    this.name = 'TooEarlyError';
    this.retryAfter = options?.retryAfter;
  }

  static is(value: unknown): value is TooEarlyError {
    return isError(value) && value.name === 'TooEarlyError';
  }
}

/**
 * Thrown when a request is rate limited.
 */
export class ThrottleError extends WorkflowError {
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
 * current World implementation supports. Users should upgrade their @workflow packages.
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
