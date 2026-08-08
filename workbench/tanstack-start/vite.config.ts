import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

export default defineConfig({
  plugins: [workflow(), tanstackStart(), nitro(), viteReact()],
  nitro: {
    plugins: ['./plugins/start-pg-world.ts'],
    // `ws` (world-vercel's events WS transport) has optional native
    // accelerator deps (`bufferutil`, `utf-8-validate`) that aren't
    // installed here. Nitro bundles `ws` into `.output/server/_libs/ws.mjs`
    // by default, which turns its runtime-optional `require('bufferutil')`
    // into a hard unresolved import that crashes the server at startup
    // ("Could not resolve \"bufferutil\" imported by \"ws\""). Mark `ws`
    // external so it's resolved from node_modules at runtime instead, where
    // it falls back to its pure-JS implementation when those deps are
    // absent — mirrors `serverExternalPackages: ['ws']` in
    // workflow-server's next.config.ts for the same underlying issue.
    rollupConfig: {
      external: ['ws'],
    },
  },
});
