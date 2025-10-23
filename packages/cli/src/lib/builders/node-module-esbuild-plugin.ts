import { ERROR_SLUGS } from '@workflow/errors';
import builtinModules from 'builtin-modules';
import type * as esbuild from 'esbuild';

const nodeModulesRegex = new RegExp(`^(${builtinModules.join('|')})`);

export function createNodeModuleErrorPlugin(): esbuild.Plugin {
  return {
    name: 'workflow-node-module-error',
    setup(build) {
      build.onResolve({ filter: nodeModulesRegex }, (args) => {
        // Ignore if the import is coming from a node_modules folder
        if (args.importer.includes('node_modules')) return null;

        // Get the working directory to check if import is from external workspace packages
        const workingDir = build.initialOptions.absWorkingDir || process.cwd();

        // Check if the importer is from an external package (outside the current project)
        // This handles workspace packages in monorepos where packages are symlinked
        // from their actual locations (e.g., ../../packages/database/dist/...)
        // Only flag imports that are clearly from the user's source code within the current project
        const isFromProjectSource = args.importer.startsWith(workingDir);

        // If the import is from outside the working directory, it's an external dependency
        // and should be allowed to use Node.js modules
        if (!isFromProjectSource) return null;

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
