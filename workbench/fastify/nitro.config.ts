import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  routes: {
    '/**': { handler: './src/index.ts', format: 'node' },
  },
  plugins: ['plugins/start-pg-world.ts'],
});
