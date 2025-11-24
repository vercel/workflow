import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

export default defineConfig({
  plugins: [nitro(), workflow()],
  nitro: {
    serverDir: './',
    hooks: {
      // Start the Postgres World
      // Needed since we test this in CI
      compiled: async () => {
        if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
          const { getWorld } = await import('workflow/runtime');
          console.log('Starting Postgres World...');
          await getWorld().start?.();
        }
      },
    },
  },
});
