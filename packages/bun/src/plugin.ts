import { transform } from '@swc/core';
import type { BunPlugin } from 'bun';

// Plugin to build workflows at runtime and do client mode transform
export function workflowPlugin(): BunPlugin {
  return {
    name: 'workflow-plugin',
    async setup(build) {
      // Client transform plugin - only transform TypeScript files
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
