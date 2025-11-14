import { defineConfig } from 'astro/config';
import { workflowPlugin } from 'workflow/astro';
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
  integrations: [workflowPlugin()],
  adapter: adapter,
  security: {
    checkOrigin: false,
  },
});
