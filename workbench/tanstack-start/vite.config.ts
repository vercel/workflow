import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

// E2E-only: mount the app below a base path (WORKFLOW_E2E_BASE_PATH=/app)
const e2eBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(/\/+$/, '');
const nitroPlugins =
  process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres'
    ? ['./plugins/start-pg-world.ts']
    : [];

export default defineConfig({
  plugins: [workflow(), tanstackStart(), nitro(), viteReact()],
  nitro: {
    baseURL: e2eBasePath ? `${e2eBasePath}/` : undefined,
    plugins: nitroPlugins,
  },
});
