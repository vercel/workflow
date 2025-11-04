import { createDevTests } from './dev-test-factory';

createDevTests({
  generatedStepPath: 'app/.well-known/workflow/v1/step/route.js',
  generatedWorkflowPath: 'app/.well-known/workflow/v1/flow/route.js',
  apiFilePath: 'app/api/chat/route.ts',
  apiFileImportPath: '../../../',
});
