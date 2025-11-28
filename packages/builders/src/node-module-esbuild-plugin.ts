import { ERROR_SLUGS } from '@workflow/errors';
import builtinModules from 'builtin-modules';
import type * as esbuild from 'esbuild';

// Match exact Node.js built-in module names:
// - "fs", "path", "stream" etc. (exact match)
// - "node:fs", "node:path" etc. (with node: prefix)
// - "bun" (exact match)
// - "bun:sqlite", "bun:ffi" etc. (with bun: prefix)
// But NOT "some-package/stream" or "eventsource-parser/stream"
const nodeModulesPattern = `(${builtinModules.join('|')})`;
const nodeModulesRegex = new RegExp(`^${nodeModulesPattern}$`);
const bunModulesRegex = /^bun(:|$)/;
const regex = new RegExp(`^(${nodeModulesPattern}|bun(:.*)?)$`);

export function createNodeModuleErrorPlugin(): esbuild.Plugin {
  return {
    name: 'workflow-node-module-error',
    setup(build) {
      build.onResolve({ filter: regex }, (args) => {
        const isNodeModule = nodeModulesRegex.test(args.path);
        const isBunModule = bunModulesRegex.test(args.path);
        const moduleType = isNodeModule
          ? 'Node.js '
          : isBunModule
            ? 'Bun '
            : '';

        return {
          path: args.path,
          errors: [
            {
              text: `Cannot use ${moduleType}module "${args.path}" in workflow functions. Move this module to a step function.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`,
            },
          ],
        };
      });
    },
  };
}
