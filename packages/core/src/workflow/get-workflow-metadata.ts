import { redirectStackToCaller } from '../capture-stack.js';
import { NotInWorkflowOrStepContextError } from '../context-violation-error.js';

export interface WorkflowMetadata {
  /**
   * The name of the workflow.
   */
  workflowName: string;

  /**
   * Unique identifier for the workflow run.
   */
  workflowRunId: string;

  /**
   * Timestamp when the workflow run started.
   */
  workflowStartedAt: Date;

  /**
   * The URL where the workflow can be triggered.
   */
  url: string;

  /**
   * Feature flags indicating which capabilities are active for this workflow run.
   */
  features: {
    /**
     * Whether encryption is enabled for this workflow run.
     * When `true`, step inputs, outputs, and other serialized data
     * are encrypted at rest.
     */
    encryption: boolean;
  };
}

export const WORKFLOW_CONTEXT_SYMBOL =
  /* @__PURE__ */ Symbol.for('WORKFLOW_CONTEXT');

export function getWorkflowMetadata(): WorkflowMetadata {
  // Inside the workflow VM, the context is stored in the globalThis object
  // behind a symbol.
  const ctx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as WorkflowMetadata;
  if (!ctx) {
    // Use the shared `NotInWorkflowOrStepContextError` — it lives in
    // `context-violation-error.ts` specifically so this file can throw it
    // without creating a module-init cycle (the full `context-errors.ts`
    // depends on this file's `WORKFLOW_CONTEXT_SYMBOL`).
    const err = new NotInWorkflowOrStepContextError(
      'getWorkflowMetadata()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/get-workflow-metadata'
    );
    // Redirect the stack to the caller so terminal overlays (Next.js,
    // Turbopack, VS Code) point at the user's code rather than this frame.
    redirectStackToCaller(err, getWorkflowMetadata);
    throw err;
  }
  return ctx;
}
