import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  srcDir: 'src',
  serverEntry: 'index.ts',
  modules: ['workflow/nitro'],
});
