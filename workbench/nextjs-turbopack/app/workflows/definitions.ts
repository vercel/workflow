import { allWorkflows } from '@/_workflows';

export type WorkflowDefinition = {
  workflowFile: string;
  name: string;
  displayName: string;
  description?: string;
  defaultArgs: unknown[];
};

// Default arguments for workflows that require them
const DEFAULT_ARGS_MAP: Record<string, unknown[]> = {
  addTenWorkflow: [5],
  hookWorkflow: [`test-token-${Date.now()}`, 'custom-data'],
  webhookWorkflow: [
    `webhook-token-1-${Date.now()}`,
    `webhook-token-2-${Date.now()}`,
    `webhook-token-3-${Date.now()}`,
  ],
  hookCleanupTestWorkflow: [`cleanup-token-${Date.now()}`, 'cleanup-data'],
  closureVariableWorkflow: [42],
};

// Dynamically generate workflow definitions from allWorkflows
export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = Object.entries(
  allWorkflows
)
  .flatMap(([workflowFile, workflows]) =>
    Object.entries(workflows)
      .filter(([_, value]) => typeof value === 'function')
      .map(([name]) => ({
        workflowFile,
        name,
        displayName: name,
        defaultArgs: DEFAULT_ARGS_MAP[name] || [],
      }))
  )
  .sort((a, b) => {
    // Sort by file name first, then by workflow name
    if (a.workflowFile !== b.workflowFile) {
      return a.workflowFile.localeCompare(b.workflowFile);
    }
    return a.name.localeCompare(b.name);
  });

export type WorkflowName = string;
