import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, 'app'),
    },
  },
});
