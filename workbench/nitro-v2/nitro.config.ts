import { defineNitroConfig } from 'nitropack/config';

export default defineNitroConfig({
  compatibilityDate: 'latest',
  srcDir: 'server',
  modules: ['workflow/nitro'],
});
