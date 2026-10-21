import node from '@sveltejs/adapter-node';
import vercel from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { workflowPlugin } from 'workflow/sveltekit';

// Node adapter needed for ci tests
const adapter = process.env.VERCEL_DEPLOYMENT_ID ? vercel() : node();

export default defineConfig({
  plugins: [
    workflowPlugin(),
    sveltekit({
      adapter,
      // WARNING: CSRF protection is disabled for testing/development purposes.
      // This configuration trusts all origins and should NOT be used in production.
      // In production, specify only trusted origins or remove this configuration
      // to use SvelteKit's default CSRF protection.
      csrf: { trustedOrigins: ['*'] },
      alias: {
        '@repo/*': '../../*',
      },
    }),
  ],
});
