import type { TestProject } from 'vitest/node';
import { buildWorkflowTests } from './index.js';
import {
  readProvidedWorkflowTestOptions,
  WORKFLOW_VITEST_OPTIONS_KEY,
} from './options.js';

export async function setup(project: TestProject) {
  await buildWorkflowTests(
    readProvidedWorkflowTestOptions(
      project.getProvidedContext()[WORKFLOW_VITEST_OPTIONS_KEY]
    )
  );
}
