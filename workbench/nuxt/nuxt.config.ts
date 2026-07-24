import { fileURLToPath } from 'node:url';

// E2E-only: mount the app below a base path (WORKFLOW_E2E_BASE_PATH=/app)
const e2eBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(/\/+$/, '');

export default defineNuxtConfig({
  app: e2eBasePath ? { baseURL: `${e2eBasePath}/` } : undefined,
  compatibilityDate: 'latest',
  modules: ['workflow/nuxt'],
  alias: {
    '@repo': fileURLToPath(new URL('../../', import.meta.url)),
  },
});
