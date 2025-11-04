import { createDevTests } from './dev-test-factory';

createDevTests({
  generatedStepPath: '.nitro/workflow/steps.mjs',
  generatedWorkflowPath: '.nitro/workflow/workflows.mjs',
  apiFilePath: 'routes/api/chat.post.ts',
  apiFileImportPath: '../..',
});
