import { transform } from '@swc/core';
import { resolveModulePath } from 'exsolve';
import type { HmrContext, Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';

export function workflowPlugin(): Plugin {
  let builder: SvelteKitBuilder;

  return {
    name: 'workflow:sveltekit',

    // TODO: Move this to @workflow/vite or something since this is vite specific
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

    // TODO: Move this to @workflow/vite or something since this is vite specific
    async handleHotUpdate(ctx: HmrContext) {
      const { file, server, read } = ctx;

      // Check if this is a TS/JS file that might contain workflow directives
      const jsTsRegex = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
      if (!jsTsRegex.test(file)) {
        return;
      }

      // Read the file to check for workflow/step directives
      const content = await read();
      const useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m;
      const useStepPattern = /^\s*(['"])use step\1;?\s*$/m;

      if (!useWorkflowPattern.test(content) && !useStepPattern.test(content)) {
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
