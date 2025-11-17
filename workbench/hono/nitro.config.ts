import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  handlers: [
    {
      route: '/api/**',
      handler: './server.ts',
    },
  ],
});
