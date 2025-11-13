import { defineNuxtModule } from '@nuxt/kit';
import type { NuxtModule } from '@nuxt/schema';
import type { ModuleOptions as NitroModuleOptions } from '@workflow/nitro';

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
      nuxt.options.nitro.workflow ||= {} as NitroModuleOptions;
      nuxt.options.nitro.workflow.typescriptPlugin = options.typescriptPlugin;
      nuxt.options.nitro.modules.push('@workflow/nitro');
    }
  },
});
