import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  preset: 'vercel',
  modules: ['workflow/nitro'],
  serverEntry: './src/index.ts'
});
