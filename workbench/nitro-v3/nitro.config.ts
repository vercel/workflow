import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  serverDir: './',
  modules: ['workflow/nitro'],
  // Workaround for monorepo symlinked packages
  externals: {
    external: [(id) => id.includes('.nitro/workflow')],
  },
  rollupConfig: {
    watch: {
      exclude: ['**/.workflow-data/**', '**/node_modules/**'],
    },
  },
});
