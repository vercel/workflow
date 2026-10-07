import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vitest.config';

// Reruns the storage suites against the flat layout that releases before
// run-scoped storage wrote, which is still read and written as-is (see
// TEST_LAYOUT in src/test-helpers.ts).
export default mergeConfig(
  base,
  defineConfig({ test: { env: { WORKFLOW_LOCAL_TEST_LAYOUT: 'flat' } } })
);
