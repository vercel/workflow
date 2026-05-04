import { throwNotInWorkflowOrStepContext } from '../context-errors.js';
import type { WorkflowMetadata } from '../workflow/get-workflow-metadata.js';
import { contextStorage } from './context-storage.js';

export type { WorkflowMetadata };

/**
 * Returns metadata available in the current workflow run inside a step function.
 */
export function getWorkflowMetadata(): WorkflowMetadata {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throwNotInWorkflowOrStepContext(
      'getWorkflowMetadata()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/get-workflow-metadata',
      getWorkflowMetadata
    );
  }
  return ctx.workflowMetadata;
}
