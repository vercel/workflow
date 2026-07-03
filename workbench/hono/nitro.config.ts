import { defineConfig } from 'nitro';

const workflowBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(
  /\/+$/,
  ''
);
const workflowBaseURL = workflowBasePath ? `${workflowBasePath}/` : undefined;

export default defineConfig({
  baseURL: workflowBaseURL,
  modules: ['workflow/nitro'],
  routes: {
    '/**': './src/index.ts',
  },
  plugins: ['plugins/start-pg-world.ts'],
});
