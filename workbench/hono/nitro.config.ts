import { defineConfig } from 'nitro';

// E2E-only: mount the app below a base path (WORKFLOW_E2E_BASE_PATH=/app)
const e2eBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(/\/+$/, '');

export default defineConfig({
  baseURL: e2eBasePath ? `${e2eBasePath}/` : undefined,
  modules: ['workflow/nitro'],
  routes: {
    '/**': './src/index.ts',
  },
  plugins: ['plugins/start-pg-world.ts'],
});
