import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  routes: {
    '/api/**': './src/index.ts',
  },
});
