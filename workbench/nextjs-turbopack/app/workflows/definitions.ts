import 'server-only';

import { allWorkflows } from '@/_workflows';
import type { WorkflowDefinition } from './types';

const RANDOM_ARG_PLACEHOLDER = '<random-id>';

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
  hookWorkflow: [RANDOM_ARG_PLACEHOLDER, RANDOM_ARG_PLACEHOLDER],
  webhookWorkflow: [
    RANDOM_ARG_PLACEHOLDER,
    RANDOM_ARG_PLACEHOLDER,
    RANDOM_ARG_PLACEHOLDER,
  ],
  hookCleanupTestWorkflow: [RANDOM_ARG_PLACEHOLDER, RANDOM_ARG_PLACEHOLDER],
  closureVariableWorkflow: [7],
  // 100_durable_agent_e2e.ts
  agentBasicE2e: ['hello world'],
  agentToolCallE2e: [3, 7],
  agentMultiStepE2e: [],
  agentErrorToolE2e: [],
  agentOnStepFinishE2e: [],
  agentOnFinishE2e: [],
  agentInstructionsStringE2e: [],
  agentTimeoutE2e: [],
  agentOnStartE2e: [],
  agentOnStepStartE2e: [],
  agentOnToolCallStartE2e: [],
  agentOnToolCallFinishE2e: [],
  agentPrepareCallE2e: [],
  agentToolApprovalE2e: [],
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
