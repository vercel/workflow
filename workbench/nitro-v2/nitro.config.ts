import { defineNitroConfig } from 'nitropack/config';

const workflowBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(
  /\/+$/,
  ''
);
const workflowBaseURL = workflowBasePath ? `${workflowBasePath}/` : undefined;

export default defineNitroConfig({
  baseURL: workflowBaseURL,
  compatibilityDate: 'latest',
  srcDir: 'server',
  modules: ['workflow/nitro'],
});
