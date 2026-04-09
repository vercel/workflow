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
  // Inside the workflow VM, the context is stored in the globalThis object behind a symbol
  const ctx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as WorkflowMetadata;
  if (!ctx) {
    throw new Error(
      '`getWorkflowMetadata()` can only be called inside a workflow or step function'
    );
  }
  return ctx;
}
