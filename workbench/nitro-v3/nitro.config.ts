import { defineConfig } from 'nitro';

export default defineConfig({
  modules: ['workflow/nitro'],
  serverDir: './',
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
