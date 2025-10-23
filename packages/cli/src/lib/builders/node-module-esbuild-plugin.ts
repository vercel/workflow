import { ERROR_SLUGS } from '@workflow/errors';
import builtinModules from 'builtin-modules';
import type * as esbuild from 'esbuild';
import { parentHasChild } from './discover-entries-esbuild-plugin.js';

const nodeModulesRegex = new RegExp(`^(${builtinModules.join('|')})`);

export function createNodeModuleErrorPlugin(
  options: { workflowFiles?: string[] } = {}
): esbuild.Plugin {
  return {
    name: 'workflow-node-module-error',
    setup(build) {
      build.onResolve({ filter: nodeModulesRegex }, (args) => {
        // Ignore if the import is coming from a node_modules folder
        if (args.importer.includes('node_modules')) return null;

        // Get the working directory to check if import is from external workspace packages
        const workingDir = build.initialOptions.absWorkingDir || process.cwd();

        // Only flag imports that are clearly from the user's source code within the current project
        const isFromProjectSource =
          args.importer.startsWith(`${workingDir}/`) ||
          args.importer === workingDir;

        if (!isFromProjectSource) return null;

        // If entries are provided, only enforce for files that are in the workflow graph
        const entries = options.workflowFiles || [];

        if (entries.length > 0) {
          let isInWorkflowGraph = false;

          for (const entry of entries) {
            if (
              args.importer === entry ||
              parentHasChild(args.importer, entry)
            ) {
              isInWorkflowGraph = true;

              break;
            }
          }

          if (!isInWorkflowGraph) return null;
        }

        return {
          path: args.path,
          errors: [
            {
              text: `Cannot use Node.js module "${args.path}" in workflow functions. Move this module to a step function.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`,
            },
          ],
        };
      });
    },
  };
}
