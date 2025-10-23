import type { WorkflowMetadata } from '../workflow/get-workflow-metadata.js';
import { contextStorage } from './context-storage.js';

export type { WorkflowMetadata };

/**
 * Returns metadata available in the current workflow run inside a step function.
 */
export function getWorkflowMetadata(): WorkflowMetadata {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      '`getWorkflowMetadata()` can only be called inside a workflow or step function'
    );
  }
  return ctx.workflowMetadata;
}
