import { defineConfig } from 'nitro';

// E2E-only: mount the app below a base path (WORKFLOW_E2E_BASE_PATH=/app)
const e2eBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(/\/+$/, '');
const plugins =
  process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres'
    ? ['plugins/start-pg-world.ts']
    : [];

export default defineConfig({
  baseURL: e2eBasePath ? `${e2eBasePath}/` : undefined,
  modules: ['workflow/nitro'],
  serverDir: './',
  plugins,
});
