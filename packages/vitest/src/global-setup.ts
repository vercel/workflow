import { buildWorkflowTests } from './index.js';

export async function setup() {
  const dirs = process.env.__WORKFLOW_VITEST_DIRS
    ? (JSON.parse(process.env.__WORKFLOW_VITEST_DIRS) as string[])
    : undefined;
  await buildWorkflowTests({ dirs });
}
