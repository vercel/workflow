import { allWorkflows } from '@/_workflows';

export type WorkflowDefinition = {
  workflowFile: string;
  name: string;
  displayName: string;
  description?: string;
  defaultArgs: unknown[];
};

// Default arguments for workflows that require them
// Based on e2e test arguments from packages/core/e2e/e2e.test.ts
const DEFAULT_ARGS_MAP: Record<string, unknown[]> = {
  // 1_simple.ts
  simple: [42],
  // 4_ai.ts
  ai: ['What is the weather in San Francisco?'],
  agent: ['What is the weather in Muscat?'],
  // 7_full.ts
  handleUserSignup: ['user@example.com'],
  // 97_bench.ts
  noStepsWorkflow: [42],
  oneStepWorkflow: [10],
  promiseAllStressTestWorkflow: [5],
  promiseRaceStressTestLargeWorkflow: [5],
  // 98_duplicate_case.ts
  addTenWorkflow: [123],
  // 99_e2e.ts
  hookWorkflow: [
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ],
  webhookWorkflow: [
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ],
  hookCleanupTestWorkflow: [
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ],
  closureVariableWorkflow: [7],
};

// Dynamically generate workflow definitions from allWorkflows
export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = Object.entries(
  allWorkflows
)
  .flatMap(([workflowFile, workflows]) =>
    Object.entries(workflows)
      .filter(
        ([_, value]) =>
          typeof value === 'function' &&
          'workflowId' in value &&
          typeof value.workflowId === 'string'
      )
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
