import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

const workflowBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(
  /\/+$/,
  ''
);
const workflowBaseURL = workflowBasePath ? `${workflowBasePath}/` : undefined;

export default defineConfig({
  plugins: [workflow(), tanstackStart(), nitro(), viteReact()],
  nitro: {
    baseURL: workflowBaseURL,
    plugins: ['./plugins/start-pg-world.ts'],
  },
});
