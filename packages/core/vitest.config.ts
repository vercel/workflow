import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.js';

// The unit tests (`pnpm test`). The e2e suites keep the root config.
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      setupFiles: ['./vitest.setup.ts'],
    },
  })
);
