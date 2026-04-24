import { Ansi } from '@workflow/errors';

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
    // Avoid importing the structured context-error classes here — the
    // `context-errors.ts` module imports from this file, so bringing those
    // in eagerly would create a module-init cycle. Render the same framing
    // inline, and redirect the stack to the user's call site so terminal
    // overlays point at their code, not at this function.
    const err = new Error(
      Ansi.frame(
        `${Ansi.code('getWorkflowMetadata()')} can only be called inside a workflow or step function`,
        [
          Ansi.docs(
            'https://workflow-sdk.dev/docs/api-reference/workflow/get-workflow-metadata'
          ),
        ]
      )
    );
    const capture = (
      Error as unknown as {
        captureStackTrace?: (target: object, fn: Function) => void;
      }
    ).captureStackTrace;
    capture?.(err, getWorkflowMetadata);
    throw err;
  }
  return ctx;
}
