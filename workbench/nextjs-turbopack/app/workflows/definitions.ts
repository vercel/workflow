import { allWorkflows } from '@/_workflows';

export type WorkflowDefinition = {
  workflowFile: string;
  name: string;
  displayName: string;
  description?: string;
  defaultArgs: unknown[];
};

// Helper to convert camelCase or PascalCase to Title Case
function toTitleCase(str: string): string {
  // Remove "Workflow" suffix if present
  const withoutSuffix = str.replace(/Workflow$/, '');
  // Add space before capital letters and capitalize first letter
  return withoutSuffix
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .replace(/^./, (s) => s.toUpperCase());
}

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
        displayName: toTitleCase(name),
        defaultArgs: [],
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
