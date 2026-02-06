import { defineConfig } from 'nitro';

export default defineConfig({
  modules: ['workflow/nitro'],
  routes: {
    '/**': './src/index.ts',
  },
  publicAssets: [{ dir: 'public' }],
  plugins: ['plugins/start-pg-world.ts'],
});
