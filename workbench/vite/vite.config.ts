import { fileURLToPath } from 'node:url';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

export default defineConfig({
  plugins: [nitro(), workflow()],
  // Nitro beta does not resolve tsconfig paths for Vite's server build.
  // The shared e2e workflows import from @repo/lib, so mirror that alias here.
  resolve: {
    alias: {
      '@repo': fileURLToPath(new URL('../../', import.meta.url)),
    },
  },
  nitro: {
    serverDir: './',
    plugins: ['plugins/start-pg-world.ts'],
  },
});
