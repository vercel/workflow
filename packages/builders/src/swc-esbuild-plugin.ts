import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { promisify } from 'node:util';
import enhancedResolveOrig from 'enhanced-resolve';
import type { Plugin } from 'esbuild';
import {
  applySwcTransform,
  type WorkflowManifest,
} from './apply-swc-transform.js';
import {
  jsTsRegex,
  parentHasChild,
} from './discover-entries-esbuild-plugin.js';

export interface SwcPluginOptions {
  mode: 'step' | 'workflow' | 'client';
  entriesToBundle?: string[];
  outdir?: string;
  tsPaths?: Record<string, string[]>;
  tsBaseUrl?: string;
  workflowManifest?: WorkflowManifest;
}

const NODE_RESOLVE_OPTIONS = {
  dependencyType: 'commonjs',
  modules: ['node_modules'],
  exportsFields: ['exports'],
  importsFields: ['imports'],
  conditionNames: ['node', 'require'],
  descriptionFiles: ['package.json'],
  extensions: ['.ts', '.mts', '.cjs', '.js', '.json', '.node'],
  enforceExtensions: false,
  symlinks: true,
  mainFields: ['main'],
  mainFiles: ['index'],
  roots: [],
  fullySpecified: false,
  preferRelative: false,
  preferAbsolute: false,
  restrictions: [],
};

const NODE_ESM_RESOLVE_OPTIONS = {
  ...NODE_RESOLVE_OPTIONS,
  dependencyType: 'esm',
  conditionNames: ['node', 'import'],
};

export function createSwcPlugin(options: SwcPluginOptions): Plugin {
  return {
    name: 'swc-workflow-plugin',
    setup(build) {
      // everything is external unless explicitly configured
      // to be bundled
      const cjsResolver = promisify(
        enhancedResolveOrig.create(NODE_RESOLVE_OPTIONS)
      );
      const esmResolver = promisify(
        enhancedResolveOrig.create(NODE_ESM_RESOLVE_OPTIONS)
      );

      const enhancedResolve = async (context: string, path: string) => {
        try {
          return await esmResolver(context, path);
        } catch (_) {
          return cjsResolver(context, path);
        }
      };

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (!options.entriesToBundle) {
          return null;
        }

        try {
          let resolvedPath: string | false | undefined = args.path;

          // handle local imports e.g. ./hello or ../another
          if (args.path.startsWith('.')) {
            resolvedPath = await enhancedResolve(args.resolveDir, args.path);
          } else {
            resolvedPath = await enhancedResolve(
              // `args.resolveDir` is not used here to ensure we only
              // externalize packages that can be resolved in the
              // project's working directory e.g. a nested dep can't
              // be externalized as we won't be able to resolve it once
              // it's parent has been bundled
              build.initialOptions.absWorkingDir || process.cwd(),
              args.path
            );
          }

          if (!resolvedPath) return null;

          // Normalize to forward slashes for cross-platform comparison
          const normalizedResolvedPath = resolvedPath.replace(/\\/g, '/');

          for (const entryToBundle of options.entriesToBundle) {
            const normalizedEntry = entryToBundle.replace(/\\/g, '/');

            if (normalizedResolvedPath === normalizedEntry) {
              return null;
            }

            // if the current entry imports a child that needs
            // to be bundled then it needs to also be bundled so
            // that the child can have our transform applied
            if (parentHasChild(normalizedResolvedPath, normalizedEntry)) {
              return null;
            }
          }

          const isFilePath =
            args.path.startsWith('.') || args.path.startsWith('/');

          return {
            external: true,
            path: isFilePath
              ? relative(options.outdir || process.cwd(), resolvedPath).replace(
                  /\\/g,
                  '/'
                )
              : args.path,
          };
        } catch (_) {}
        return null;
      });

      // Handle TypeScript and JavaScript files
      build.onLoad({ filter: jsTsRegex }, async (args) => {
        // Determine if this is a TypeScript file
        try {
          // Determine the loader based on the output
          let loader: 'js' | 'jsx' | 'tsx' = 'js';
          if (args.path.endsWith('.jsx')) {
            loader = 'jsx';
          } else if (args.path.endsWith('.tsx')) {
            loader = 'tsx';
          }
          const source = await readFile(args.path, 'utf8');

          // Calculate relative path for SWC plugin
          // The filename parameter is used to generate workflowId/stepId, so it must be relative
          const workingDir =
            build.initialOptions.absWorkingDir || process.cwd();
          // Normalize paths: convert backslashes to forward slashes and remove trailing slashes
          const normalizedWorkingDir = workingDir
            .replace(/\\/g, '/')
            .replace(/\/$/, '');
          const normalizedPath = args.path.replace(/\\/g, '/');

          // Windows fix: Always do case-insensitive path comparison as the PRIMARY logic
          // to work around node:path.relative() not recognizing paths with different drive
          // letter casing (e.g., D: vs d:) as being in the same tree
          const lowerWd = normalizedWorkingDir.toLowerCase();
          const lowerPath = normalizedPath.toLowerCase();

          let relativeFilepath: string;
          if (lowerPath.startsWith(lowerWd + '/')) {
            // File is under working directory - manually calculate relative path
            // This ensures we get a relative path even with drive letter casing issues
            relativeFilepath = normalizedPath.substring(
              normalizedWorkingDir.length + 1
            );
          } else if (lowerPath === lowerWd) {
            // File IS the working directory
            relativeFilepath = '.';
          } else {
            // File is outside working directory - use relative() and strip ../ prefixes if needed
            relativeFilepath = relative(
              normalizedWorkingDir,
              normalizedPath
            ).replace(/\\/g, '/');

            // Handle files discovered outside the working directory
            // These come back as ../path/to/file, but we want just path/to/file
            if (relativeFilepath.startsWith('../')) {
              relativeFilepath = relativeFilepath
                .split('/')
                .filter((part) => part !== '..')
                .join('/');
            }
          }

          // Final safety check - ensure we never pass an absolute path to SWC
          if (
            relativeFilepath.includes(':') ||
            relativeFilepath.startsWith('/')
          ) {
            // This should never happen, but if it does, use just the filename as last resort
            console.error(
              `[ERROR] relativeFilepath is still absolute: ${relativeFilepath}`
            );
            relativeFilepath = normalizedPath.split('/').pop() || 'unknown.ts';
          }

          const { code: transformedCode, workflowManifest } =
            await applySwcTransform(
              relativeFilepath,
              source,
              options.mode,
              // we need to provide the tsconfig/jsconfig
              // alias via swc so that we can resolve them
              // with our custom resolve logic
              {
                paths: options.tsPaths,
                baseUrl: options.tsBaseUrl,
              }
            );

          if (!options.workflowManifest) {
            options.workflowManifest = {};
          }

          options.workflowManifest.workflows = Object.assign(
            options.workflowManifest.workflows || {},
            workflowManifest.workflows
          );
          options.workflowManifest.steps = Object.assign(
            options.workflowManifest.steps || {},
            workflowManifest.steps
          );

          return {
            contents: transformedCode,
            loader,
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(
            `❌ SWC transform error in ${args.path}:`,
            errorMessage
          );
          return {
            errors: [
              {
                text: `SWC transform failed: ${errorMessage}`,
                location: { file: args.path, line: 0, column: 0 },
              },
            ],
          };
        }
      });
    },
  };
}
