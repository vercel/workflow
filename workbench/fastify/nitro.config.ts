import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  routes: {
    '/**': { handler: './src/index.ts', format: 'node' },
  },
  publicAssets: [{ dir: 'public' }],
  plugins: ['plugins/start-pg-world.ts'],
});
