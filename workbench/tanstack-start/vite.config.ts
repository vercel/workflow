import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

const nitroPlugins =
  process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres'
    ? ['./plugins/start-pg-world.ts']
    : [];

export default defineConfig({
  plugins: [workflow(), tanstackStart(), nitro(), viteReact()],
  nitro: {
    plugins: nitroPlugins,
  },
});
