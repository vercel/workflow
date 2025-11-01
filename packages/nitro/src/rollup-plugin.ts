import { transform } from '@swc/core';
import { resolveModulePath } from 'exsolve';
import type { RollupConfig } from 'nitro/types';

type RollupPlugin = Exclude<
  RollupConfig['plugins'],
  undefined | undefined | null | false | Promise<unknown> | Array<unknown>
>;

// https://github.com/vercel/workflow/blob/feat/nitro/packages/next/src/loader.ts

export function workflowRollupPlugin(): RollupPlugin {
  return {
    name: 'workflow-rollup-plugin',
    // This transform applies the "use workflow"/"use step"
    // client transformation
    async transform(code: string, id: string) {
      // only apply the transform if file needs it
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
  };
}
