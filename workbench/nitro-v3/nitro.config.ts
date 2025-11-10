import { defineConfig } from 'nitro';

<<<<<<< HEAD
export default defineConfig({
  modules: ['workflow/nitro'],
  serverDir: './',
=======
export default defineNitroConfig({
  serverDir: './',
  modules: [
    'workflow/nitro'
  ],
  // Workaround for monorepo symlinked packages
  externals: {
    external: [id => id.includes('.nitro/workflow')]
  },
>>>>>>> 1c3c8731 (refactor: migrate to latest nitro v3)
});
