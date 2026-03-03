import { workflow } from '@workflow/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
});
