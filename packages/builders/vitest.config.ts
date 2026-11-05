import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.js';

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      globalSetup: ['./vitest.global-setup.ts'],
    },
  })
);
