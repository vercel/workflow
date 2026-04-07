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
import { resolveWorkflowAliasRelativePath } from './workflow-alias.js';

export interface SwcPluginOptions {
  mode: 'step' | 'workflow' | 'client';
  entriesToBundle?: string[];
  outdir?: string;
  projectRoot?: string;
  workflowManifest?: WorkflowManifest;
  /**
   * Rewrite TypeScript extensions (.ts, .tsx, .mts, .cts) to their JS
   * equivalents (.js, .mjs, .cjs) in externalized import paths.
   *
   * Enable this when the output bundle is consumed directly by Node's native
   * ESM loader (e.g. vitest), which cannot resolve .ts extensions.
   *
   * Leave disabled (default) when a downstream bundler (webpack, Vite, etc.)
   * handles resolution — those tools resolve .ts natively and rewriting
   * breaks them because the .js file doesn't exist on disk.
   */
  rewriteTsExtensions?: boolean;
  /**
   * Absolute file paths of discovered workflow/step/serde entries whose
   * imports must be treated as side-effectful.
   *
   * The SWC compiler transform injects registration calls (workflow IDs,
   * step IDs, class serialization, etc.) into these files. Without this
   * override, esbuild honours `"sideEffects": false` from the package's
   * `package.json` and silently drops bare imports of these modules.
   */
  sideEffectEntries?: string[];
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

      // Pre-compute the normalized side-effect entries set for O(1) lookups.
      const normalizedSideEffectEntries = new Set(
        options.sideEffectEntries?.map((e) => e.replace(/\\/g, '/'))
      );

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.skipSwcPlugin) return null;

        if (
          !options.entriesToBundle &&
          normalizedSideEffectEntries.size === 0
        ) {
          return null;
        }

        // When only sideEffectEntries is set (no entriesToBundle), we only
        // need to override sideEffects for top-level bare imports — typically
        // from the virtual entry. Skip resolution for transitive imports
        // (dynamic imports, requires, etc.) to avoid unnecessary overhead.
        if (!options.entriesToBundle && args.kind !== 'import-statement') {
          return null;
        }

        try {
          const specifier = args.path;
          const specifierIsPath =
            specifier.startsWith('.') || specifier.startsWith('/');

          let resolvedPath: string | false | undefined;
          // Determines whether the external path should be relativized
          // (project-local file) or kept as a bare specifier (npm package).
          let shouldMakeRelative = specifierIsPath;

          if (specifierIsPath) {
            resolvedPath = await enhancedResolve(args.resolveDir, specifier);
          } else {
            // Resolve from project root so nested deps aren't externalized
            resolvedPath = await enhancedResolve(
              build.initialOptions.absWorkingDir || process.cwd(),
              specifier
            ).catch(() => undefined); // swallow so esbuild fallback below can try

            // Fall back to esbuild for aliases/tsconfig paths,
            // but only accept project-local results
            if (!resolvedPath) {
              const esbuildResult = await build.resolve(specifier, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: { skipSwcPlugin: true },
              });
              const didResolve =
                !!esbuildResult.path && !esbuildResult.errors.length;
              const isProjectLocalFile =
                didResolve &&
                !esbuildResult.path
                  .replace(/\\/g, '/')
                  .includes('/node_modules/');
              if (isProjectLocalFile) {
                resolvedPath = esbuildResult.path;
                shouldMakeRelative = true;
              }
            }
          }

          if (!resolvedPath) return null;

          // Normalize to forward slashes for cross-platform comparison
          const normalizedResolvedPath = resolvedPath.replace(/\\/g, '/');

          // Check if this module is a discovered entry whose SWC-transformed
          // code contains side effects (workflow/step/class registration).
          // Override the package.json "sideEffects": false so esbuild does not
          // drop bare imports of these modules.
          const hasSideEffects = normalizedSideEffectEntries.has(
            normalizedResolvedPath
          );

          if (options.entriesToBundle) {
            let shouldBundle = false;
            for (const entryToBundle of options.entriesToBundle) {
              const normalizedEntry = entryToBundle.replace(/\\/g, '/');

              if (normalizedResolvedPath === normalizedEntry) {
                shouldBundle = true;
                break;
              }

              // if the current entry imports a child that needs
              // to be bundled then it needs to also be bundled so
              // that the child can have our transform applied
              if (parentHasChild(normalizedResolvedPath, normalizedEntry)) {
                shouldBundle = true;
                break;
              }
            }

            if (shouldBundle) {
              // Let esbuild bundle this entry, but override sideEffects if needed.
              // We must return the resolved `path` alongside `sideEffects` because
              // returning only `{ sideEffects: true }` without a path causes esbuild
              // to fall through to its own resolver, which re-reads the package.json
              // and applies `"sideEffects": false` from there.
              return hasSideEffects
                ? { path: resolvedPath, sideEffects: true }
                : null;
            }

            let externalPath: string;
            if (shouldMakeRelative) {
              externalPath = relative(
                options.outdir || process.cwd(),
                resolvedPath
              ).replace(/\\/g, '/');

              if (options.rewriteTsExtensions) {
                // Rewrite TypeScript extensions to their JS equivalents so the
                // externalized import is loadable by Node's native ESM loader.
                externalPath = externalPath
                  .replace(/\.tsx?$/, '.js')
                  .replace(/\.mts$/, '.mjs')
                  .replace(/\.cts$/, '.cjs');
              }
            } else {
              externalPath = specifier;
            }

            return {
              external: true,
              path: externalPath,
              sideEffects: hasSideEffects || undefined,
            };
          }

          // No entriesToBundle — only override sideEffects when needed.
          // We must return the resolved `path` alongside `sideEffects` because
          // returning only `{ sideEffects: true }` without a path causes esbuild
          // to fall through to its own resolver, which re-reads the package.json
          // and applies `"sideEffects": false` from there.
          return hasSideEffects
            ? { path: resolvedPath, sideEffects: true }
            : null;
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
          const normalizedSource = source
            .replace(/require\(\s*(['"])server-only\1\s*\)/g, 'void 0')
            .replace(/require\(\s*(['"])client-only\1\s*\)/g, 'void 0');

          // Calculate relative path for SWC plugin
          // The filename parameter is used to generate workflowId/stepId, so it must be relative
          const workingDir =
            build.initialOptions.absWorkingDir || process.cwd();
          const projectRoot = options.projectRoot || workingDir;
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
              const aliasedRelativePath =
                await resolveWorkflowAliasRelativePath(args.path, workingDir);
              if (aliasedRelativePath) {
                relativeFilepath = aliasedRelativePath;
              } else {
                relativeFilepath = relativeFilepath
                  .split('/')
                  .filter((part) => part !== '..')
                  .join('/');
              }
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
              normalizedSource,
              options.mode,
              args.path, // Pass absolute path for module specifier resolution
              projectRoot
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
