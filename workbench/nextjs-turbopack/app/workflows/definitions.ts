export type WorkflowDefinition = {
  workflowFile: string;
  name: string;
  displayName: string;
  description: string;
  defaultArgs: unknown[];
};

export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'addTenWorkflow',
    displayName: 'Add Ten',
    description: 'Adds 10 to a number through multiple steps (2+3+5)',
    defaultArgs: [5],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'nestedErrorWorkflow',
    displayName: 'Nested Error',
    description: 'Tests error handling with deeply nested function calls',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'promiseAllWorkflow',
    displayName: 'Promise.all',
    description: 'Runs three random delay steps in parallel',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'promiseRaceWorkflow',
    displayName: 'Promise.race',
    description: 'Races three steps with different delays',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'promiseAnyWorkflow',
    displayName: 'Promise.any',
    description: 'Returns first successful result from multiple steps',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'readableStreamWorkflow',
    displayName: 'Readable Stream',
    description: 'Generates a readable stream with incremental data',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'hookWorkflow',
    displayName: 'Hook',
    description: 'Creates a hook and waits for payloads',
    defaultArgs: ['test-token-' + Date.now(), 'custom-data'],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'webhookWorkflow',
    displayName: 'Webhook',
    description: 'Creates multiple webhooks with different response types',
    defaultArgs: [
      'webhook-token-1-' + Date.now(),
      'webhook-token-2-' + Date.now(),
      'webhook-token-3-' + Date.now(),
    ],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'sleepingWorkflow',
    displayName: 'Sleep',
    description: 'Sleeps for 10 seconds and returns timestamps',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'nullByteWorkflow',
    displayName: 'Null Byte',
    description: 'Tests handling of null bytes in strings',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'workflowAndStepMetadataWorkflow',
    displayName: 'Metadata',
    description: 'Retrieves workflow and step metadata',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'outputStreamWorkflow',
    displayName: 'Output Stream',
    description: 'Demonstrates writable output streams',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'outputStreamInsideStepWorkflow',
    displayName: 'Output Stream (Inside Step)',
    description: 'Demonstrates writable streams called inside steps',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'fetchWorkflow',
    displayName: 'Fetch',
    description: 'Fetches data from an external API',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'promiseRaceStressTestWorkflow',
    displayName: 'Promise.race Stress Test',
    description: 'Stress tests Promise.race with multiple delays',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'retryAttemptCounterWorkflow',
    displayName: 'Retry Counter',
    description: 'Tests retry logic with attempt counter',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'crossFileErrorWorkflow',
    displayName: 'Cross-File Error',
    description: 'Tests error handling across imported modules',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'retryableAndFatalErrorWorkflow',
    displayName: 'Retryable & Fatal Errors',
    description: 'Tests both retryable and fatal error handling',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'hookCleanupTestWorkflow',
    displayName: 'Hook Cleanup',
    description: 'Tests hook cleanup after receiving one payload',
    defaultArgs: ['cleanup-token-' + Date.now(), 'cleanup-data'],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'stepFunctionPassingWorkflow',
    displayName: 'Step Function Passing',
    description: 'Tests passing step functions as arguments',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'stepFunctionWithClosureWorkflow',
    displayName: 'Step Function with Closure',
    description: 'Tests step functions that capture closure variables',
    defaultArgs: [],
  },
  {
    workflowFile: 'workflows/99_e2e.ts',
    name: 'closureVariableWorkflow',
    displayName: 'Closure Variables',
    description: 'Tests workflow functions with closure scope variables',
    defaultArgs: [42],
  },
];

export type WorkflowName = (typeof WORKFLOW_DEFINITIONS)[number]['name'];
