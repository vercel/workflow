// Framework-specific dev test configurations
const DEV_TEST_CONFIGS = {
  'nextjs-turbopack': {
    generatedStepRegistrationPath:
      'app/.well-known/workflow/v1/flow/__step_registrations.js',
    generatedWorkflowPath: 'app/.well-known/workflow/v1/flow/route.js',
    apiFilePath: 'app/api/chat/route.ts',
    apiFileImportPath: '../../..',
  },
  'nextjs-webpack': {
    generatedStepRegistrationPath:
      'app/.well-known/workflow/v1/flow/__step_registrations.js',
    generatedWorkflowPath: 'app/.well-known/workflow/v1/flow/route.js',
    apiFilePath: 'app/api/chat/route.ts',
    apiFileImportPath: '../../..',
  },
  nitro: {
    generatedStepRegistrationPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: 'routes/api/chat.post.ts',
    apiFileImportPath: '../..',
  },
  nuxt: {
    generatedStepRegistrationPath: '.nuxt/workflow/steps.mjs',
    generatedWorkflowPath: '.nuxt/workflow/workflows.mjs',
    apiFilePath: 'server/api/chat.post.ts',
    apiFileImportPath: '../..',
  },
  sveltekit: {
    generatedStepRegistrationPath:
      'src/routes/.well-known/workflow/v1/flow/__step_registrations.js',
    generatedWorkflowPath: 'src/routes/.well-known/workflow/v1/flow/+server.js',
    apiFilePath: 'src/routes/api/chat/+server.ts',
    apiFileImportPath: '../../../..',
    workflowsDir: 'src/workflows',
  },
  vite: {
    generatedStepRegistrationPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: 'routes/api/chat.post.ts',
    apiFileImportPath: '../..',
  },
  hono: {
    generatedStepRegistrationPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: './src/index.ts',
    apiFileImportPath: '..',
  },
  express: {
    generatedStepRegistrationPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: './src/index.ts',
    apiFileImportPath: '..',
  },
  fastify: {
    generatedStepRegistrationPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: './src/index.ts',
    apiFileImportPath: '..',
  },
  nest: {
    generatedStepRegistrationPath: '.nestjs/workflow/steps.mjs',
    generatedWorkflowPath: '.nestjs/workflow/workflows.mjs',
    apiFilePath: './src/app.controller.ts',
    apiFileImportPath: '..',
    workflowsDir: 'src/workflows',
  },
  astro: {
    generatedStepRegistrationPath:
      'src/pages/.well-known/workflow/v1/__step_registrations.js',
    generatedWorkflowPath: 'src/pages/.well-known/workflow/v1/flow.js',
    apiFilePath: 'src/pages/api/chat.ts',
    apiFileImportPath: '../..',
    workflowsDir: 'src/workflows',
  },
  'tanstack-start': {
    generatedStepRegistrationPath: 'node_modules/.nitro/workflow/steps.mjs',
    generatedWorkflowPath: 'node_modules/.nitro/workflow/workflows.mjs',
    apiFilePath: 'src/routes/api/chat.ts',
    apiFileImportPath: '../../..',
  },
};

function createMatrixEntry(name, project, config, overrides = {}) {
  const canary = overrides.canary === true;

  return {
    name,
    project,
    ...config,
    runLabel: canary ? 'canary' : 'stable',
    artifactSuffix: canary ? 'canary' : 'stable',
    ...overrides,
  };
}

const matrix = {
  app: [],
};

for (const app of [
  {
    name: 'nextjs-turbopack',
    project: 'example-nextjs-workflow-turbopack',
  },
  {
    name: 'nextjs-webpack',
    project: 'example-nextjs-workflow-webpack',
  },
]) {
  matrix.app.push(
    createMatrixEntry(app.name, app.project, DEV_TEST_CONFIGS[app.name])
  );
  matrix.app.push(
    createMatrixEntry(app.name, app.project, DEV_TEST_CONFIGS[app.name], {
      canary: true,
    })
  );
}

matrix.app.push(
  createMatrixEntry('nitro', 'workbench-nitro-workflow', DEV_TEST_CONFIGS.nitro)
);
matrix.app.push(
  createMatrixEntry(
    'sveltekit',
    'workbench-sveltekit-workflow',
    DEV_TEST_CONFIGS.sveltekit
  )
);
matrix.app.push(
  createMatrixEntry('nuxt', 'workbench-nuxt-workflow', DEV_TEST_CONFIGS.nuxt)
);
matrix.app.push(
  createMatrixEntry('hono', 'workbench-hono-workflow', DEV_TEST_CONFIGS.hono)
);
matrix.app.push(
  createMatrixEntry('vite', 'workbench-vite-workflow', DEV_TEST_CONFIGS.vite)
);
matrix.app.push(
  createMatrixEntry(
    'express',
    'workbench-express-workflow',
    DEV_TEST_CONFIGS.express
  )
);
matrix.app.push(
  createMatrixEntry(
    'fastify',
    'workbench-fastify-workflow',
    DEV_TEST_CONFIGS.fastify
  )
);
matrix.app.push(
  createMatrixEntry('nest', 'workbench-nest-workflow', DEV_TEST_CONFIGS.nest)
);
matrix.app.push(
  createMatrixEntry('astro', 'workbench-astro-workflow', DEV_TEST_CONFIGS.astro)
);

matrix.app.push({
  name: 'tanstack-start',
  project: 'workbench-tanstack-start-workflow',
  ...DEV_TEST_CONFIGS['tanstack-start'],
});

console.log(JSON.stringify(matrix));
