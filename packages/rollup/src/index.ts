import { relative } from 'node:path';
import { transform } from '@swc/core';
import {
  armWorkflowAppGraph,
  assertWorkflowsAreRegistered,
  detectWorkflowPatterns,
  isGeneratedWorkflowFile,
  recordTransformedWorkflows,
  resolveAppGraphDir,
  resolveModuleSpecifier,
  resolveWorkflowAliasRelativePath,
  shouldTransformFile,
  WORKFLOW_OPTIONAL_OTEL_API_MODULE,
  WORKFLOW_OPTIONAL_WS_NATIVE_MODULES,
} from '@workflow/builders';
import { resolveModulePath } from 'exsolve';
import type { Plugin } from 'rollup';

export interface WorkflowTransformPluginOptions {
  /**
   * Directories to exclude from transformation (e.g., pre-built workflow bundles).
   * Paths should use forward slashes and will be matched as prefixes.
   */
  exclude?: string[];
}

export function workflowTransformPlugin(
  options: WorkflowTransformPluginOptions = {}
): Plugin {
  const { exclude = [] } = options;

  // Workflow IDs already reported in this process, so the several compiler
  // passes a framework runs do not repeat the same finding.
  const reportedWorkflowIds = new Set<string>();

  return {
    name: 'workflow:transform',
    /**
     * Arm the registration check for this build. Idempotent per process, so
     * the client and server passes — and the worker threads SvelteKit spawns,
     * which inherit the armed environment — record into one set rather than
     * wiping each other's.
     */
    async buildStart() {
      await armWorkflowAppGraph({
        appGraphDir: resolveAppGraphDir(),
      });
    },
    /**
     * Compare what this app can start against what the build registered.
     *
     * Runs at the end of every pass rather than at some known-final one: a
     * partial app graph can only produce a subset of the findings a complete
     * one would, so an early pass under-reports and never over-reports, and
     * the last pass sees everything. Which pass is last is a property of the
     * host framework that this plugin has no way to know.
     */
    async closeBundle() {
      await assertWorkflowsAreRegistered({
        workingDir: process.cwd(),
        reportedWorkflowIds,
      });
    },
    resolveId: {
      order: 'pre',
      async handler(source, importer, options) {
        // `@opentelemetry/api` is an optional peer the SDK imports lazily.
        // Externalize it ONLY when it isn't installed: otherwise Rollup/Vite
        // fails the build with "failed to resolve import '@opentelemetry/api'"
        // when the peer is absent (observed in SvelteKit's pipeline). When the
        // peer IS installed we must let it resolve and bundle normally: a
        // self-contained output (Nitro's `.output/server`, esbuild) ships no
        // node_modules, so forcing it external there strands the runtime
        // `import('@opentelemetry/api')` and crashes the server with
        // ERR_MODULE_NOT_FOUND. Externalize (not a stub alias) so tracing still
        // loads the real API at runtime when present.
        if (
          source === WORKFLOW_OPTIONAL_OTEL_API_MODULE ||
          source.startsWith(`${WORKFLOW_OPTIONAL_OTEL_API_MODULE}/`)
        ) {
          const resolved = await this.resolve(source, importer, {
            ...options,
            skipSelf: true,
          });
          return resolved ?? { id: source, external: true };
        }

        // `ws`'s optional native accelerators. Unlike the OTEL peer above these
        // are externalized unconditionally, not only when unresolvable: `ws`
        // requires them in a try/catch, so a failed runtime require is the
        // designed path while a partially bundled native module is not. This
        // plugin also runs under Vite, which substitutes a stub for an absent
        // optional peer and would let that require succeed with no working
        // masker. See WORKFLOW_OPTIONAL_WS_NATIVE_MODULES.
        if (
          WORKFLOW_OPTIONAL_WS_NATIVE_MODULES.some(
            (name) => source === name || source.startsWith(`${name}/`)
          )
        ) {
          return { id: source, external: true };
        }

        return null;
      },
    },
    // This transform applies the "use workflow"/"use step"
    // step transformation
    async transform(code: string, id: string) {
      // Skip generated workflow route files to avoid re-processing them
      if (isGeneratedWorkflowFile(id)) {
        return null;
      }

      // Skip files in excluded directories (e.g., pre-built workflow bundles)
      const normalizedId = id.replace(/\\/g, '/');
      for (const excludePath of exclude) {
        const normalizedExclude = excludePath.replace(/\\/g, '/');
        if (normalizedId.startsWith(normalizedExclude)) {
          return null;
        }
      }

      const patterns = detectWorkflowPatterns(code);

      if (!shouldTransformFile(id, patterns)) {
        return null;
      }

      const isTypeScript =
        id.endsWith('.ts') ||
        id.endsWith('.tsx') ||
        id.endsWith('.mts') ||
        id.endsWith('.cts');

      const swcPlugin = resolveModulePath('@workflow/swc-plugin', {
        from: [import.meta.url],
      });

      // Calculate relative filename for SWC plugin
      // The SWC plugin uses filename to generate workflowId, so it must be relative
      const workingDir = process.cwd();
      const normalizedWorkingDir = workingDir
        .replace(/\\/g, '/')
        .replace(/\/$/, '');
      const normalizedFilepath = id.replace(/\\/g, '/');

      // Windows fix: Use case-insensitive comparison to work around drive letter casing issues
      const lowerWd = normalizedWorkingDir.toLowerCase();
      const lowerPath = normalizedFilepath.toLowerCase();

      let relativeFilename: string;
      if (lowerPath.startsWith(`${lowerWd}/`)) {
        // File is under working directory - manually calculate relative path
        relativeFilename = normalizedFilepath.substring(
          normalizedWorkingDir.length + 1
        );
      } else if (lowerPath === lowerWd) {
        // File IS the working directory (shouldn't happen)
        relativeFilename = '.';
      } else {
        // Use relative() for files outside working directory
        relativeFilename = relative(workingDir, id).replace(/\\/g, '/');

        if (relativeFilename.startsWith('../')) {
          // A workflow reached through a symlink — a shared `workflows/`
          // directory linked into the app, which this repo's own workbench
          // does — resolves to its real path here, outside the app. Stripping
          // the `../` segments names it by wherever it really lives, while
          // the builder globs it through the link and names it by the app.
          // The two then disagree about the workflow's id, and `start()`
          // enqueues one the registry has never heard of. `@workflow/next`
          // and the esbuild transform both resolve the alias back; this one
          // did not.
          const aliasedRelativePath = await resolveWorkflowAliasRelativePath(
            id,
            workingDir
          );
          relativeFilename =
            aliasedRelativePath ??
            relativeFilename
              .split('/')
              .filter((part) => part !== '..')
              .join('/');
        }
      }

      // Final safety check - ensure we never pass an absolute path to SWC
      if (relativeFilename.includes(':') || relativeFilename.startsWith('/')) {
        // This should rarely happen, but use filename split as last resort
        relativeFilename = normalizedFilepath.split('/').pop() || 'unknown.ts';
      }

      // Resolve module specifier for packages (node_modules or workspace packages)
      const { moduleSpecifier } = resolveModuleSpecifier(id, workingDir);

      // Transform with SWC
      const result = await transform(code, {
        filename: relativeFilename,
        jsc: {
          parser: {
            ...(isTypeScript
              ? {
                  syntax: 'typescript',
                  tsx: id.endsWith('.tsx'),
                }
              : {
                  syntax: 'ecmascript',
                  jsx: id.endsWith('.jsx'),
                }),
          },
          target: 'es2022',
          experimental: {
            plugins: [[swcPlugin, { mode: 'step', moduleSpecifier }]],
          },
          transform: {
            react: {
              runtime: 'preserve',
            },
          },
        },
        minify: false,
        // Rollup composes transform maps itself. Do not let SWC separately
        // resolve sourceMappingURL comments against this normalized module id.
        inputSourceMap: false,
        sourceMaps: true,
        inlineSourcesContent: true,
      });

      await recordTransformedWorkflows({ file: id, code: result.code });

      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map) : null,
      };
    },
  };
}
