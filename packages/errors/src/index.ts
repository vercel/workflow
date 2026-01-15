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
 * Thrown when a Workflow API request fails.
 *
 * This error is thrown when HTTP requests to the Workflow backend fail,
 * typically due to network issues, invalid requests, or server errors.
 *
 * @example
 * ```ts
 * try {
 *   await startWorkflow('myWorkflow', input);
 * } catch (error) {
 *   if (error instanceof WorkflowAPIError) {
 *     console.error(`API error (${error.status}):`, error.message);
 *   }
 * }
 * ```
 */
export class WorkflowAPIError extends WorkflowError {
  status?: number;
  code?: string;
  url?: string;

  constructor(
    message: string,
    options?: { status?: number; url?: string; code?: string; cause?: unknown }
  ) {
    super(message, {
      cause: options?.cause,
    });
    this.name = 'WorkflowAPIError';
    this.status = options?.status;
    this.code = options?.code;
    this.url = options?.url;
  }

  static is(value: unknown): value is WorkflowAPIError {
    return isError(value) && value.name === 'WorkflowAPIError';
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
        `Please upgrade @workflow packages.`
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
  'Your current vercel account does not have access to this resource. Use `vercel login` or `vercel switch` to ensure you are linked to the right account. You might need to run `vercel env pull` to use the latest environment variables.';
