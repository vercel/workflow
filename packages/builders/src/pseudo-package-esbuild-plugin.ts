import type * as esbuild from 'esbuild';

/**
 * Pseudo-packages are marker packages with no actual functionality - they only
 * throw errors when imported in the wrong context (e.g., client-side vs server-side).
 * In the workflow VM context, we don't need their behavior, so we provide empty modules.
 */
export const PSEUDO_PACKAGES = new Set([
  'server-only',
  'client-only',
  'next/dist/compiled/server-only',
  'next/dist/compiled/client-only',
]);

/**
 * Creates an esbuild plugin that handles pseudo-packages like 'server-only' and 'client-only'.
 *
 * These packages need special handling because:
 * 1. They have exports defined in package.json that esbuild needs to resolve
 * 2. Without this plugin, esbuild may fail to resolve them during bundling
 * 3. Marking them as external would generate require() calls that don't work in the workflow VM
 *
 * This plugin intercepts imports of these packages and provides empty modules,
 * which is safe because they are marker packages with no actual functionality.
 */
export function createPseudoPackagePlugin(): esbuild.Plugin {
  return {
    name: 'workflow-pseudo-packages',
    setup(build: esbuild.PluginBuild) {
      // Intercept imports of pseudo packages and redirect to our namespace
      build.onResolve({ filter: /.*/ }, (args: esbuild.OnResolveArgs) => {
        if (PSEUDO_PACKAGES.has(args.path)) {
          return {
            path: args.path,
            namespace: 'pseudo-package',
          };
        }
        return null;
      });

      // Provide empty module content for pseudo packages
      build.onLoad(
        { filter: /.*/, namespace: 'pseudo-package' },
        (args: esbuild.OnLoadArgs) => {
          return {
            contents: `/* Pseudo-package: ${args.path} - no-op in workflow context */`,
            loader: 'js',
          };
        }
      );
    },
  };
}
