import { afterAll } from 'vitest';
import { setupWorkflowTests, teardownWorkflowTests } from './index.js';

await setupWorkflowTests();

afterAll(async () => {
  await teardownWorkflowTests();
});
