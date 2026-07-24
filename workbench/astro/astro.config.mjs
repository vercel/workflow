import node from '@astrojs/node';
import vercel from '@astrojs/vercel';
import { defineConfig } from 'astro/config';
import { workflow } from 'workflow/astro';

// Node adapter needed for ci tests
const adapter = process.env.VERCEL_DEPLOYMENT_ID
  ? vercel()
  : node({
      mode: 'standalone',
    });
// E2E-only: mount the app below a base path (WORKFLOW_E2E_BASE_PATH=/app)
const e2eBasePath = process.env.WORKFLOW_E2E_BASE_PATH?.replace(/\/+$/, '');

// https://astro.build/config
export default defineConfig({
  base: e2eBasePath || undefined,
  output: 'server',
  integrations: [workflow()],
  adapter: adapter,
  // WARNING: CSRF protection is disabled for testing/development purposes.
  // This configuration trusts all origins and should NOT be used in production.
  // In production, specify only trusted origins or remove this configuration
  // to use Astro's default CSRF protection.
  security: {
    checkOrigin: false,
  },
});
