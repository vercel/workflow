import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  routes: {
    '/**': './src/index.ts',
  },
  // NOTE: `bun` preset doesn't work as expected since Nitro does not pass
  // the `idleTimeout` option through Elysia, causing workflow suspensions > 10s to fail
  // preset: "bun"
  plugins: ['plugins/start-pg-world.ts'],
});
