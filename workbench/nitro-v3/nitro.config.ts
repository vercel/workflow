import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  serverDir: './',
  modules: [
    'workflow/nitro'
  ],
  // Workaround for monorepo symlinked packages
  externals: {
    external: [id => id.includes('.nitro/workflow')]
  },
});
