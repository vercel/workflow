import { defineConfig } from 'nitro';

export default defineConfig({
  modules: ['workflow/nitro'],
  serverDir: './',
  plugins: ['plugins/start-pg-world.ts'],
});
