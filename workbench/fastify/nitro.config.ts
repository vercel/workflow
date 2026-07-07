import { defineNitroConfig } from 'nitro/config';

const plugins =
  process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres'
    ? ['plugins/start-pg-world.ts']
    : [];

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  routes: {
    '/**': { handler: './src/index.ts', format: 'node' },
  },
  plugins,
});
