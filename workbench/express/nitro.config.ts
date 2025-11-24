import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  routes: {
    '/**': './src/index.ts',
  },
  hooks: {
    // Start the Postgres World
    // Needed since we test this in CI
    compiled: async () => {
      if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
        import('workflow/runtime').then(async ({ getWorld }) => {
          console.log('Starting Postgres World...');
          await getWorld().start?.();
        });
      }
    },
  },
});
