// @ts-check
import { defineConfig } from 'astro/config';
import { workflowPlugin } from 'workflow/astro';

// https://astro.build/config
export default defineConfig({
  vite: { plugins: [workflowPlugin()] },
});
