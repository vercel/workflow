import { fileURLToPath } from 'node:url';

const workflowBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(
  /\/+$/,
  ''
);
const workflowBaseURL = workflowBasePath ? `${workflowBasePath}/` : undefined;

export default defineNuxtConfig({
  app: workflowBaseURL ? { baseURL: workflowBaseURL } : undefined,
  compatibilityDate: 'latest',
  modules: ['workflow/nuxt'],
  alias: {
    '@repo': fileURLToPath(new URL('../../', import.meta.url)),
  },
});
