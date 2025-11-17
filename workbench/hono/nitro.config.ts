import { defineConfig } from 'nitro';

export default defineConfig({
  modules: ['workflow/nitro'],
<<<<<<< HEAD
  routes: {
    '/**': './src/index.ts',
  },
=======
  externals: {
    external: [(id) => id.includes('.nitro/workflow')],
  },
  handlers: [
    {
      route: '/api/**',
      handler: './server.ts',
    },
  ],
>>>>>>> feacfaa2 (fix(hono): externalize nitro workflow output dir)
});
