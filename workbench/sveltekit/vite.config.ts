import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { workflowPlugin } from 'workflow/sveltekit';

export default defineConfig({
  plugins: [workflowPlugin(), sveltekit()],
});
