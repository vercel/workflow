import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@workflow/core/runtime/world-target': fileURLToPath(
        new URL('./packages/world-local/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    testTimeout: 60_000,
  },
});
