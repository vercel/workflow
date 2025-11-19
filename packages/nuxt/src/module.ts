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

const module: NuxtModule<ModuleOptions> = defineNuxtModule({
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

    // Exclude .nuxt/workflow from Vite's file watcher to prevent HMR on generated files
    nuxt.options.vite ||= {};
    nuxt.options.vite.server ||= {};
    nuxt.options.vite.server.watch ||= {};
    nuxt.options.vite.server.watch.ignored ||= [];

    const ignored = nuxt.options.vite.server.watch.ignored;
    if (Array.isArray(ignored)) {
      ignored.push('**/.nuxt/workflow/**');
    } else if (typeof ignored === 'function') {
      const originalIgnored = ignored;
      nuxt.options.vite.server.watch.ignored = (file: string) => {
        if (file.includes('.nuxt/workflow')) {
          return true;
        }
        return originalIgnored(file);
      };
    }
  },
});

export default module;
