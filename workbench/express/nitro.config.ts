import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  preset: 'vercel',
  modules: ['workflow/nitro'],
  vercel: { entryFormat: "web" },
  handlers: [ { route: '/api/**', handler: 'src/index.ts' } ],
});
