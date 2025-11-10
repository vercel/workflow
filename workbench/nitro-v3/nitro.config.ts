import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  serverDir: './',
  modules: [
    'workflow/nitro'
  ],
  // Workaround for monorepo symlinks
  noExternals: true,
  rollupConfig: {
    watch: {
      exclude: ['**/.workflow-data/**', '**/node_modules/**']
    }
  }
});
