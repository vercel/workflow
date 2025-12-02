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
    generatedStepPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: 'routes/api/chat.post.ts',
    apiFileImportPath: '../..',
  },
  nuxt: {
    generatedStepPath: '.nuxt/workflow/steps.mjs',
    generatedWorkflowPath: '.nuxt/workflow/workflows.mjs',
    apiFilePath: 'server/api/chat.post.ts',
    apiFileImportPath: '../..',
  },
  sveltekit: {
    generatedStepPath: 'src/routes/.well-known/workflow/v1/step/+server.js',
    generatedWorkflowPath: 'src/routes/.well-known/workflow/v1/flow/+server.js',
    apiFilePath: 'src/routes/api/chat/+server.ts',
    apiFileImportPath: '../../../..',
    workflowsDir: 'src/workflows',
  },
  vite: {
    generatedStepPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: 'routes/api/trigger.post.ts',
    apiFileImportPath: '../..',
  },
  hono: {
    generatedStepPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: './src/index.ts',
    apiFileImportPath: '..',
  },
  express: {
    generatedStepPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: './src/index.ts',
    apiFileImportPath: '..',
  },
  astro: {
    generatedStepPath: 'src/pages/.well-known/workflow/v1/step.js',
    generatedWorkflowPath: 'src/pages/.well-known/workflow/v1/flow.js',
    apiFilePath: 'src/pages/api/chat.ts',
    apiFileImportPath: '../..',
    workflowsDir: 'src/workflows',
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

matrix.app.push({
  name: 'nuxt',
  project: 'workbench-nuxt-workflow',
  ...DEV_TEST_CONFIGS.nuxt,
});

matrix.app.push({
  name: 'hono',
  project: 'workbench-hono-workflow',
  ...DEV_TEST_CONFIGS.hono,
});

matrix.app.push({
  name: 'vite',
  project: 'workbench-vite-workflow',
  ...DEV_TEST_CONFIGS.vite,
});

matrix.app.push({
  name: 'express',
  project: 'workbench-express-workflow',
  ...DEV_TEST_CONFIGS.express,
});

matrix.app.push({
  name: 'astro',
  project: 'workbench-astro-workflow',
  ...DEV_TEST_CONFIGS.astro,
});

console.log(JSON.stringify(matrix));
