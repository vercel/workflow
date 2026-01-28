import { readFile, realpath } from 'node:fs/promises';
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
  resolvedPathToPackageName,
} from './discover-entries-esbuild-plugin.js';

/**
 * Extract the package path for use in workflow/step/class IDs.
 *
 * For files inside node_modules, returns "node_modules/{package-name}" which provides
 * a stable identifier that works across different export conditions. Different export
 * conditions (e.g., "workflow" vs "import") resolve to different files within a package,
 * but should produce the same IDs for serialization compatibility.
 *
 * Returns null if the path is not in node_modules (i.e., it's a local project file).
 *
 * Examples:
 * - /project/node_modules/just-bash/dist/Bash.js → "node_modules/just-bash"
 * - /project/node_modules/@scope/pkg/index.js → "node_modules/@scope/pkg"
 * - /project/node_modules/.pnpm/just-bash@1.0.0/node_modules/just-bash/dist/Bash.js → "node_modules/just-bash"
 */
function extractPackagePathForIds(filePath: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Find the last occurrence of node_modules in the path
  // This handles pnpm's nested node_modules structure
  const nodeModulesIndex = normalizedPath.lastIndexOf('/node_modules/');
  if (nodeModulesIndex === -1) {
    return null;
  }

  // Get the part after node_modules/
  const afterNodeModules = normalizedPath.substring(
    nodeModulesIndex + '/node_modules/'.length
  );
  const parts = afterNodeModules.split('/');

  if (parts.length === 0) {
    return null;
  }

  // Check if it's a scoped package (@scope/name)
  if (parts[0].startsWith('@') && parts.length >= 2) {
    return `node_modules/${parts[0]}/${parts[1]}`;
  }

  return `node_modules/${parts[0]}`;
}

export interface SwcPluginOptions {
  mode: 'step' | 'workflow' | 'client';
  entriesToBundle?: string[];
  outdir?: string;
  workflowManifest?: WorkflowManifest;
}

const NODE_RESOLVE_OPTIONS = {
  dependencyType: 'commonjs',
  modules: ['node_modules'],
  exportsFields: ['exports'],
  importsFields: ['imports'],
  conditionNames: ['node', 'require'],
  descriptionFiles: ['package.json'],
  extensions: [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.cjs',
    '.mjs',
    '.js',
    '.jsx',
    '.json',
    '.node',
  ],
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

/**
 * Extract the package name from a bare specifier import.
 * Returns null if it's not a package import (e.g., relative path).
 *
 * Examples:
 * - "just-bash" → "just-bash"
 * - "just-bash/workflow" → "just-bash"
 * - "@scope/pkg" → "@scope/pkg"
 * - "@scope/pkg/subpath" → "@scope/pkg"
 * - "./foo" → null
 * - "/abs/path" → null
 */
function extractPackageNameFromSpecifier(specifier: string): string | null {
  // Not a bare specifier
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return null;
  }

  const parts = specifier.split('/');

  // Scoped package: @scope/name or @scope/name/subpath
  if (parts[0].startsWith('@')) {
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  // Regular package: name or name/subpath
  return parts[0];
}

export function createSwcPlugin(options: SwcPluginOptions): Plugin {
  return {
    name: 'swc-workflow-plugin',
    setup(build) {
      // Track resolved paths to their package names
      // This allows us to determine which package a file comes from
      // even when it's symlinked (e.g., in a monorepo)
      const resolvedPathToPackage = new Map<string, string>();

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

      // Capture package imports and track the mapping from resolved path to package name.
      // This runs before esbuild's default resolution for bare specifier imports.
      const TRACKING_RESOLVE = Symbol('tracking-resolve');
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        // Avoid infinite recursion - if we're already tracking, let it through
        if (args.pluginData === TRACKING_RESOLVE) {
          return null;
        }

        const packageName = extractPackageNameFromSpecifier(args.path);
        if (!packageName) {
          return null; // Let esbuild handle it
        }

        // Let esbuild resolve the path (with our marker to prevent recursion)
        const result = await build.resolve(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          importer: args.importer,
          namespace: args.namespace,
          pluginData: TRACKING_RESOLVE,
        });

        if (result.path) {
          // Store the mapping from resolved path to package name
          const normalizedResult = result.path.replace(/\\/g, '/');
          resolvedPathToPackage.set(normalizedResult, packageName);
        }

        return result;
      });

      // Handle workflow/internal/* imports that may come from transformed files
      // inside node_modules. The SWC transform adds these imports, but the
      // package being transformed may not have 'workflow' as a dependency.
      // Resolve these from the project's working directory instead.
      build.onResolve({ filter: /^workflow\/internal\// }, async (args) => {
        try {
          const workingDir =
            build.initialOptions.absWorkingDir || process.cwd();
          const resolved = await enhancedResolve(workingDir, args.path);
          if (resolved) {
            return { path: resolved };
          }
        } catch (_) {
          // Fall through to default resolution
        }
        return null;
      });

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

          // Get the import specifier for files from packages.
          // This allows IDs to match what developers write in their imports:
          // - import { Bash } from "just-bash" → class//just-bash//Bash
          // - import { foo } from "./workflows/foo" → class//workflows/foo.ts//MyClass
          //
          // We try multiple approaches to find the package name:
          // 1. Check local tracking from onResolve (same build)
          // 2. Check shared tracking from discover phase
          // 3. Extract from path if it contains /node_modules/
          // 4. Resolve symlinks and check if real path is in node_modules
          let packagePath: string | undefined;

          // Approach 1: Check local tracking (from onResolve in this build)
          // This gives us the original import specifier (e.g., "just-bash")
          let packageName = resolvedPathToPackage.get(normalizedPath);
          if (packageName) {
            packagePath = packageName;
          }

          // Approach 2: Check shared tracking from discover phase
          if (!packagePath) {
            packageName = resolvedPathToPackageName.get(normalizedPath);
            if (packageName) {
              packagePath = packageName;
            }
          }

          // Approach 3: Extract from path if it contains /node_modules/
          if (!packagePath) {
            const extracted = extractPackagePathForIds(args.path);
            if (extracted) {
              // extracted is "node_modules/pkg-name", we just want "pkg-name"
              packagePath = extracted.replace(/^node_modules\//, '');
            }
          }

          // Approach 4: Resolve symlinks and check if real path is in node_modules
          if (!packagePath) {
            try {
              const realPath = await realpath(args.path);
              const extracted = extractPackagePathForIds(realPath);
              if (extracted) {
                packagePath = extracted.replace(/^node_modules\//, '');
              }
            } catch {
              // Ignore errors (file might not exist during virtual builds)
            }
          }

          const { code: transformedCode, workflowManifest } =
            await applySwcTransform(relativeFilepath, source, options.mode, {
              packagePath,
            });

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
          options.workflowManifest.classes = Object.assign(
            options.workflowManifest.classes || {},
            workflowManifest.classes
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
