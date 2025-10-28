import type { WorkflowAPIError } from '@/workflow-trace-viewer/api/workflow-api-client';

/**
 * Gets a user-facing error message from an error object.
 * Handles both WorkflowAPIError and regular Error instances.
 */
export const getErrorMessage = (error: Error | WorkflowAPIError): string => {
  // WorkflowAPIError already has user-facing messages
  if ('layer' in error && error.layer) {
    return error.message;
  }

  // Check if it's a 403 error
  if (
    error.message?.includes('403') ||
    error.message?.includes('Forbidden') ||
    (error as any).status === 403
  ) {
    return 'Your current Vercel account does not have access to this data. Please use `vercel login` to log in, or use `vercel switch` to ensure you can access the correct team.';
  }

  return error instanceof Error ? error.message : 'An error occurred';
};

/**
 * Legacy function for backward compatibility.
 * @deprecated Use getErrorMessage instead
 */
export const get403ErrorMessage = getErrorMessage;
