import { transform } from '@swc/core';
import { resolveModulePath } from 'exsolve';
import type { HmrContext, Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';

export function workflowPlugin(): Plugin {
  let builder: SvelteKitBuilder;

  return {
    name: 'workflow:sveltekit',

    // Transform workflow files with SWC
    async transform(code: string, id: string) {
      // Only apply the transform if file needs it
      if (!code.match(/(use step|use workflow)/)) {
        return null;
      }

      const isTypeScript = id.endsWith('.ts') || id.endsWith('.tsx');
      const isTsx = id.endsWith('.tsx');

      const swcPlugin = resolveModulePath('@workflow/swc-plugin', {
        from: [import.meta.url],
      });

      // Transform with SWC
      const result = await transform(code, {
        filename: id,
        jsc: {
          parser: {
            syntax: isTypeScript ? 'typescript' : 'ecmascript',
            tsx: isTsx,
          },
          target: 'es2022',
          experimental: {
            plugins: [[swcPlugin, { mode: 'client' }]],
          },
        },
        minify: false,
        sourceMaps: true,
        inlineSourcesContent: true,
      });

      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map) : null,
      };
    },

    configResolved() {
      builder = new SvelteKitBuilder();
    },

    async buildStart() {
      await builder.build();
    },

    async handleHotUpdate(ctx: HmrContext) {
      const { file, server } = ctx;

      // Only care about workflow directory changes
      if (!file.includes('/workflows/')) {
        return;
      }

      // Rebuild everything - simpler and more reliable than tracking individual files
      console.log('Workflow file changed, regenerating routes...');
      await builder.build();

      // Trigger full reload of workflow routes
      server.ws.send({
        type: 'full-reload',
        path: '*',
      });

      // Let Vite handle the normal HMR for the changed file
      return;
    },
  };
}
