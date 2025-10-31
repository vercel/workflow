import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { workflowPlugin } from 'workflow/sveltekit';

export default defineConfig({
  plugins: [workflowPlugin(), devtoolsJson(), sveltekit()],
});
