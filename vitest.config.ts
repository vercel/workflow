import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // Cap parallel test execution at 3 within `describe.concurrent` blocks.
    // The e2e suite is the only consumer of this config (only `test:e2e`
    // and `bench` use the root vitest setup); the default of 5 saturates
    // the workbench preview deploy / local runtime enough that load-heavy
    // tests (fibonacci tree spawn, multi-step abort sequencing) bump into
    // their per-test timeouts even though the same tests pass comfortably
    // when run sequentially.
    maxConcurrency: 3,
  },
  benchmark: {
    include: ['**/*.bench.ts'],
  },
});
