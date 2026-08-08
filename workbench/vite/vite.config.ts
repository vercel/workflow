import { fileURLToPath } from 'node:url';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

export default defineConfig({
  plugins: [nitro(), workflow()],
  // Mirror the `@repo/*` tsconfig path alias for Vite's bundler. Nitro
  // dropped automatic tsconfig-paths resolution in 3.0.1-alpha.2 and
  // removed the `experimental.tsconfigPaths` opt-in in 3.0.260415-beta+.
  // The symlinked example workflows (e.g. `99_e2e.ts`) import from
  // `@repo/lib/...`, so without this alias the Vite/Rollup build fails
  // to resolve those imports.
  resolve: {
    alias: {
      '@repo': fileURLToPath(new URL('../../', import.meta.url)),
    },
  },
  nitro: {
    serverDir: './',
    plugins: ['plugins/start-pg-world.ts'],
    // NOTE: `ws`'s optional native accelerators (`bufferutil`,
    // `utf-8-validate`) used to be externalized here. That now happens in
    // `@workflow/rollup`'s `workflowTransformPlugin`, which every Nitro-based
    // integration already installs — so a real user gets the fix without
    // copying this block into their own config.
  },
});
