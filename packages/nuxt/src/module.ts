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
    docs: 'https://workflow-sdk.dev/docs/getting-started/nuxt',
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
      // Signal to @workflow/nitro that Vite handles SSR externalization,
      // so the Nitro module should not override Nitro externals config.
      nuxt.options.nitro.workflow._vite = true;
      nuxt.options.nitro.modules.push('@workflow/nitro');
    }

    // Force Vite to bundle workflow SDK packages in SSR mode rather than
    // externalizing them. This ensures the SWC transform plugin processes
    // files containing workflow patterns and adds classId registration
    // IIFEs needed for serialization.
    //
    // `ssr.noExternal` may be `true`, a string, a RegExp, or an array.
    // If it's already `true`, everything is bundled and we don't need
    // to add anything. Otherwise, normalize to an array while preserving
    // any existing matchers, then append the workflow matchers.
    nuxt.options.vite ||= {};
    nuxt.options.vite.ssr ||= {};
    const workflowSsrMatchers: (string | RegExp)[] = [
      'workflow',
      /@workflow\//,
    ];
    const existingNoExternal = nuxt.options.vite.ssr.noExternal;
    if (existingNoExternal !== true) {
      const normalized: (string | RegExp)[] = Array.isArray(existingNoExternal)
        ? [...existingNoExternal]
        : existingNoExternal
          ? [existingNoExternal]
          : [];
      nuxt.options.vite.ssr.noExternal = [
        ...normalized,
        ...workflowSsrMatchers,
      ];
    }
  },
});

export default module;
