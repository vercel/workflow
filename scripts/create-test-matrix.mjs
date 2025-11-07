// Framework-specific dev test configurations
const DEV_TEST_CONFIGS = {
  'nextjs-turbopack': {
    generatedStepPath: 'app/.well-known/workflow/v1/step/route.js',
    generatedWorkflowPath: 'app/.well-known/workflow/v1/flow/route.js',
    apiFilePath: 'app/api/chat/route.ts',
    apiFileImportPath: '../../..',
  },
  'nextjs-webpack': {
    generatedStepPath: 'app/.well-known/workflow/v1/step/route.js',
    generatedWorkflowPath: 'app/.well-known/workflow/v1/flow/route.js',
    apiFilePath: 'app/api/chat/route.ts',
    apiFileImportPath: '../../..',
  },
  nitro: {
    generatedStepPath: '.nitro/workflow/steps.mjs',
    generatedWorkflowPath: '.nitro/workflow/workflows.mjs',
    apiFilePath: 'routes/api/chat.post.ts',
    apiFileImportPath: '../..',
  },
  sveltekit: {
    generatedStepPath: 'src/routes/.well-known/workflow/v1/step/+server.js',
    generatedWorkflowPath: 'src/routes/.well-known/workflow/v1/flow/+server.js',
    apiFilePath: 'src/routes/api/chat/+server.ts',
    apiFileImportPath: '../../../..',
  },
  vite: {
    generatedStepPath: 'dist/workflow/steps.mjs',
    generatedWorkflowPath: 'dist/workflow/workflows.mjs',
    apiFilePath: 'src/main.ts',
    apiFileImportPath: '..',
  },
};

const matrix = {
  app: [
    {
      name: 'nextjs-turbopack',
      project: 'example-nextjs-workflow-turbopack',
      ...DEV_TEST_CONFIGS['nextjs-turbopack'],
    },
    {
      name: 'nextjs-webpack',
      project: 'example-nextjs-workflow-webpack',
      ...DEV_TEST_CONFIGS['nextjs-webpack'],
    },
  ],
};

if (process.env.GITHUB_REF === 'refs/heads/main') {
  const newItems = [];

  for (const item of matrix.app) {
    newItems.push({ ...item, canary: true });
  }
  matrix.app.push(...newItems);
}

// Manually add nitro
matrix.app.push({
  name: 'nitro',
  project: 'workbench-nitro-workflow',
  ...DEV_TEST_CONFIGS.nitro,
});

matrix.app.push({
  name: 'sveltekit',
  project: 'workbench-sveltekit-workflow',
  ...DEV_TEST_CONFIGS.sveltekit,
});

console.log(JSON.stringify(matrix));
