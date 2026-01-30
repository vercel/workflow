import { relative } from 'node:path';
import { transform } from '@swc/core';
import {
  detectWorkflowPatterns,
  isGeneratedWorkflowFile,
  isWorkflowSdkFile,
  resolveModuleSpecifier,
  shouldTransformFile,
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

  return {
    name: 'workflow:transform',
    // This transform applies the "use workflow"/"use step"
    // client transformation
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

      // For @workflow SDK packages, only transform files with actual directives,
      // not files that just match serde patterns (which are internal SDK implementation files)
      if (isWorkflowSdkFile(id) && !patterns.hasDirective) {
        return null;
      }

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
          relativeFilename = relativeFilename
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
            plugins: [[swcPlugin, { mode: 'client', moduleSpecifier }]],
          },
          transform: {
            react: {
              runtime: 'preserve',
            },
          },
        },
        minify: false,
        sourceMaps: true,
        inlineSourcesContent: true,
      });

      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map) : null,
      };
    },
  };
}
