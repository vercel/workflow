import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.js';

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      // On Windows an open SQLite file cannot be deleted, and these tests
      // remove their data directory right after using it: give every
      // operation its own connection there (see `connectionMode`). Other
      // packages' tests run world-local as an app does (`brief`).
      env:
        process.platform === 'win32'
          ? { WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS: '0' }
          : {},
    },
  })
);
