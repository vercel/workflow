import { defineNitroConfig } from 'nitro/config';

// E2E-only: mount the app below a base path (WORKFLOW_E2E_BASE_PATH=/app)
const e2eBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(/\/+$/, '');
const plugins =
  process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres'
    ? ['plugins/start-pg-world.ts']
    : [];

export default defineNitroConfig({
  baseURL: e2eBasePath ? `${e2eBasePath}/` : undefined,
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  routes: {
    '/**': { handler: './src/index.ts', format: 'node' },
  },
  plugins,
});
