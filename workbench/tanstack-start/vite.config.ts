import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

export default defineConfig({
  plugins: [workflow(), tanstackStart(), nitro(), viteReact()],
  nitro: {
    plugins: ['./plugins/start-pg-world.ts'],
    // NOTE: `ws`'s optional native accelerators (`bufferutil`,
    // `utf-8-validate`) used to be externalized here. That now happens in
    // `@workflow/rollup`'s `workflowTransformPlugin`, which every Nitro-based
    // integration already installs — so a real user gets the fix without
    // copying this block into their own config.
  },
});
