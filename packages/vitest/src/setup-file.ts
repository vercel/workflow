import { afterAll, inject } from 'vitest';
import { setupWorkflowTests, teardownWorkflowTests } from './index.js';
import {
  readProvidedWorkflowTestOptions,
  WORKFLOW_VITEST_OPTIONS_KEY,
} from './options.js';

await setupWorkflowTests(
  readProvidedWorkflowTestOptions(inject(WORKFLOW_VITEST_OPTIONS_KEY))
);

afterAll(async () => {
  await teardownWorkflowTests();
});
