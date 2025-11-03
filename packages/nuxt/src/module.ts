import { defineNuxtModule } from '@nuxt/kit';

// Module options TypeScript interface definition
export interface ModuleOptions {
  /**
   * Enable TypeScript plugin for workflow
   * @default true
   */
  typescriptPlugin: boolean;
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'workflow',
    configKey: 'workflow',
    docs: 'https://useworkflow.dev/docs/getting-started/nuxt',
  },
  // Default configuration options of the Nuxt module
  defaults: {
    typescriptPlugin: true,
  },
  setup(options, nuxt) {
    nuxt.options.nitro ||= {};
    nuxt.options.nitro.modules ||= [];

    if (!nuxt.options.nitro.modules.includes('@workflow/nitro')) {
      nuxt.options.nitro.modules.push('@workflow/nitro');
    }

    if (options.typescriptPlugin) {
      nuxt.hook('nitro:config', (config) => {
        config.typescript ||= {};
        config.typescript.tsConfig ||= {};
        config.typescript.tsConfig.compilerOptions ||= {};
        config.typescript.tsConfig.compilerOptions.plugins ||= [];
        config.typescript.tsConfig.compilerOptions.plugins.push({
          name: 'workflow',
        });
      });
    }
  },
});
