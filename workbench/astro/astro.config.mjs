import { defineConfig } from 'astro/config';
import { workflow } from 'workflow/astro';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

// Node adapter needed for ci tests
const adapter = process.env.VERCEL_DEPLOYMENT_ID
  ? vercel()
  : node({
      mode: 'standalone',
    });

// https://astro.build/config
export default defineConfig({
  output: 'server',
  integrations: [
    workflow(),
    {
      name: 'workflow-init-pg-world',
      hooks: {
        // Start the Postgres World
        // Needed since we test this in CI
        'astro:server:setup': async () => {
          if (
            process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres'
          ) {
            import('workflow/runtime').then(async ({ getWorld }) => {
              console.log('Starting Postgres World...');
              await getWorld().start?.();
            });
          }
        },
      },
    },
  ],
  adapter: adapter,
  // WARNING: CSRF protection is disabled for testing/development purposes.
  // This configuration trusts all origins and should NOT be used in production.
  // In production, specify only trusted origins or remove this configuration
  // to use Astro's default CSRF protection.
  security: {
    checkOrigin: false,
  },
});
