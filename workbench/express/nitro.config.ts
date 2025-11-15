import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  srcDir: 'src',
  modules: ['workflow/nitro'],
  vercel: { entryFormat: 'node' },
  handlers: [{ route: '/api/**', handler: 'src/index.ts' }],
});
