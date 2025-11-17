import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  serverDir: './',
  modules: ['workflow/nitro'],
  rollupConfig: {
    watch: {
      exclude: ['**/.workflow-data/**', '**/node_modules/**'],
    },
  },
});
