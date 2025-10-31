import { transform } from '@swc/core';
import type { BunPlugin } from 'bun';
import { LocalBuilder } from './builders';

await new LocalBuilder().build();

export function workflowPlugin(): BunPlugin {
  return {
    name: 'workflow-plugin',
    async setup(build) {
      // Client transform plugin - only transform TypeScript files
      // JS files are already built
      build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
        const source = await Bun.file(args.path).text();

        // Optimization: Skip files that do not have any directives
        if (!source.match(/(use step|use workflow)/)) {
          return { contents: source };
        }
        const result = await transform(source, {
          filename: args.path,
          jsc: {
            experimental: {
              plugins: [
                [require.resolve('@workflow/swc-plugin'), { mode: 'client' }],
              ],
            },
          },
        });
        return { contents: result.code, loader: 'ts' };
      });
    },
  };
}
