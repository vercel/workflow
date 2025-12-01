/**
 * Workflow registry for browser workflows.
 * This is a separate file to avoid side effects from shared-worker.ts.
 */

export type WorkflowFunction = (
  ...args: unknown[]
) => Promise<unknown> | unknown;

export type WorkflowRegistry = Map<string, WorkflowFunction>;

// Workflow registry (injected at build time)
let workflowRegistry: WorkflowRegistry = new Map();

/**
 * Set the workflow registry. Called during worker initialization.
 */
export function setWorkflowRegistry(registry: WorkflowRegistry): void {
  workflowRegistry = registry;
}

/**
 * Get the workflow registry.
 */
export function getWorkflowRegistry(): WorkflowRegistry {
  return workflowRegistry;
}
