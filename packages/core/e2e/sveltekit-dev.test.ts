import { createDevTests } from './dev-test-factory';

createDevTests({
  generatedStepPath: 'src/routes/.well-known/workflow/v1/step/+server.js',
  generatedWorkflowPath: 'src/routes/.well-known/workflow/v1/flow/+server.js',
  apiFilePath: 'src/routes/api/chat/+server.ts',
  apiFileImportPath: '../../../../',
});
