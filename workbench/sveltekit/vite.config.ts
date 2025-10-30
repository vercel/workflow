import { sveltekit } from '@sveltejs/kit/vite';
import { workflowPlugin } from '@workflow/sveltekit';
import { defineConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { workflowRollupPlugin } from 'workflow/rollup-plugin';

export default defineConfig({
  plugins: [
    workflowPlugin(),
    workflowRollupPlugin(),
    devtoolsJson(),
    sveltekit(),
  ],
});
