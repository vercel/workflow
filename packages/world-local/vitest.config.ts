import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.js';

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      // Hooks write to the database as the tests do (a run to work on, say),
      // and get the same budget: on a loaded Windows runner one such write
      // waited 9s for the write lock, taking a hook past vitest's 10s
      // default, while the tests around it (60s) passed.
      hookTimeout: 60_000,
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
