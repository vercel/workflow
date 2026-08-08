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
