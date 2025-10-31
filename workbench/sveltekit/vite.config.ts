import { sveltekit } from '@sveltejs/kit/vite';
import { workflowPlugin } from '@workflow/sveltekit';
import { defineConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

export default defineConfig({
  plugins: [workflowPlugin(), devtoolsJson(), sveltekit()],
});
