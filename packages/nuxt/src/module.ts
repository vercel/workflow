import { defineNuxtModule } from '@nuxt/kit';

// Module options TypeScript interface definition
export interface ModuleOptions {}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'workflow',
    configKey: 'workflow',
    docs: 'https://useworkflow.dev/docs/getting-started/nuxt',
  },
  // Default configuration options of the Nuxt module
  defaults: {},
  setup(_options, nuxt) {
    nuxt.options.nitro ||= {};
    nuxt.options.nitro.modules ||= [];
    if (
      !nuxt.options._prepare &&
      !nuxt.options.nitro.modules.includes('workflow/nitro')
    ) {
      nuxt.options.nitro.modules.push('workflow/nitro');
    }
  },
});
