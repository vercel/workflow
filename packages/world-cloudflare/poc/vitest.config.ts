import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['poc/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
