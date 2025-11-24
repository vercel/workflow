import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  routes: {
    '/**': './src/index.ts',
  },
  plugins: ['plugins/start-pg-world.ts'],
});
