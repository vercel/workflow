import { VERCEL_403_ERROR_MESSAGE } from '@workflow/errors';
import type { ServerActionError } from '~/lib/types';

/**
 *  Error instance for API and server-side errors.
 * `error.message` will be a user-facing error message, to be displayed in UI.
 * `error.cause` will be a developer-facing error message, to be displayed in logs.
 *
 *  If the error originates from an HTTP request made from a server action,
 *  these fields will be populated:
 *  - `error.request` will be a JSON-serializable object representing the request made.
 *  - `error.layer` will be 'API'
 *
 *  If the error originates from inside the server action, or there's an error with
 *  calling the server action, these fields will be populated:
 *  - `error.layer` will be 'server'
 */
export class WorkflowWebAPIError extends Error {
  request?: any;
  layer?: 'client' | 'server' | 'API';
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      request?: any;
      layer?: 'client' | 'server' | 'API';
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'WorkflowWebAPIError';
    this.request = options?.request;
    this.layer = options?.layer;
    if (options?.cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }
}

/**
 * Helper to convert ServerActionError to WorkflowWebAPIError
 */
export function createWorkflowAPIError(
  serverError: ServerActionError
): WorkflowWebAPIError {
  return new WorkflowWebAPIError(serverError.message, {
    cause: serverError.cause,
    request: serverError.request,
    layer: serverError.layer,
  });
}

/**
 * Gets a user-facing error message from an error object.
 * Handles both WorkflowWebAPIError and regular Error instances.
 */
export const getErrorMessage = (error: Error | WorkflowWebAPIError): string => {
  if ('layer' in error && error.layer) {
    if (error instanceof WorkflowWebAPIError) {
      if (error.request?.status === 403) {
        return VERCEL_403_ERROR_MESSAGE;
      }
    }

    // WorkflowWebAPIError already has user-facing messages
    return error.message;
  }

  return error instanceof Error ? error.message : 'An error occurred';
};

/**
 * Helper to handle server action results and throw WorkflowWebAPIError on failure
 */
export async function unwrapServerActionResult<T>(
  promise: Promise<{
    success: boolean;
    data?: T;
    error?: ServerActionError;
  }>
): Promise<
  { error: WorkflowWebAPIError; result: null } | { error: null; result: T }
> {
  let result: { success: boolean; data?: T; error?: ServerActionError };
  try {
    result = await promise;
  } catch (error) {
    result = {
      success: false,
      error: error as ServerActionError,
    };
  }
  if (!result.success) {
    if (!result.error) {
      return {
        error: new WorkflowWebAPIError('Unknown error occurred', {
          layer: 'client',
        }),
        result: null,
      };
    }
    return {
      error: createWorkflowAPIError(result.error),
      result: null,
    };
  }
  return { error: null, result: result.data as T };
}

/**
 * Unwraps a server action result, throwing WorkflowWebAPIError on failure.
 * Use for simple action wrappers where you just want the result or an exception.
 */
export async function unwrapOrThrow<T>(
  promise: Promise<{
    success: boolean;
    data?: T;
    error?: ServerActionError;
  }>
): Promise<T> {
  const { error, result } = await unwrapServerActionResult(promise);
  if (error) throw error;
  return result;
}
