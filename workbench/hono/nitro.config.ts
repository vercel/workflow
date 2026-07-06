import { defineConfig } from 'nitro';

const plugins =
  process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres'
    ? ['plugins/start-pg-world.ts']
    : [];

export default defineConfig({
  modules: ['workflow/nitro'],
  routes: {
    '/**': './src/index.ts',
  },
  plugins,
});
