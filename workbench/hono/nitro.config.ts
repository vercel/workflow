import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  externals: {
    external: [(id) => id.includes('.nitro/workflow')],
  },
  handlers: [
    {
      route: '/api/**',
      handler: './server.ts',
    },
  ],
});
