import type { TestProject } from 'vitest/node';
import { buildWorkflowTests } from './index.js';
import {
  readProvidedWorkflowTestOptions,
  WORKFLOW_VITEST_OPTIONS_KEY,
} from './options.js';

export async function setup(project: TestProject) {
  const providedOptions =
    project.getProvidedContext()[WORKFLOW_VITEST_OPTIONS_KEY] ??
    project.config.provide?.[WORKFLOW_VITEST_OPTIONS_KEY];

  await buildWorkflowTests(readProvidedWorkflowTestOptions(providedOptions));
}
