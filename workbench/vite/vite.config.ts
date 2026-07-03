import { fileURLToPath } from 'node:url';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

const workflowBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(
  /\/+$/,
  ''
);
const workflowBaseURL = workflowBasePath ? `${workflowBasePath}/` : undefined;

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
    baseURL: workflowBaseURL,
    serverDir: './',
    plugins: ['plugins/start-pg-world.ts'],
  },
});
