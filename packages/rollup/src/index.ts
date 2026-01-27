import { relative } from 'node:path';
import { transform } from '@swc/core';
import { resolveModulePath } from 'exsolve';
import type { Plugin } from 'rollup';

// Pattern to detect generated workflow route files that should be excluded from transformation
const generatedWorkflowPathPattern = /[/\\]\.well-known[/\\]workflow[/\\]/;

// Pattern to detect @workflow SDK packages that should be excluded from transformation
// These packages are already built and don't need client-side transformation
// Matches both: node_modules/@workflow/* and monorepo packages/*/dist paths
const workflowSdkPathPattern =
  /[/\\](?:@workflow[/\\]|packages[/\\](?:builders|core|rollup|vite|next|nitro|serde|workflow|swc-plugin-workflow)[/\\])/;

// Patterns for detecting custom class serialization:
// - Import from '@workflow/serde'
// - Direct usage of Symbol.for('workflow-serialize') or Symbol.for('workflow-deserialize')
const workflowSerdeImportPattern = /from\s+(['"])@workflow\/serde\1/;
const workflowSerdeSymbolPattern =
  /Symbol\.for\s*\(\s*(['"])workflow-(?:serialize|deserialize)\1\s*\)/;

export function workflowTransformPlugin(): Plugin {
  return {
    name: 'workflow:transform',
    // This transform applies the "use workflow"/"use step"
    // client transformation
    async transform(code: string, id: string) {
      // Skip generated workflow route files to avoid re-processing them
      if (generatedWorkflowPathPattern.test(id)) {
        return null;
      }

      // Check if file needs transformation:
      // - Contains 'use step' or 'use workflow' directives
      // - Contains custom serialization patterns (@workflow/serde import or Symbol.for usage)
      const hasDirective = /(use step|use workflow)/.test(code);
      const hasSerde =
        workflowSerdeImportPattern.test(code) ||
        workflowSerdeSymbolPattern.test(code);

      // For @workflow SDK packages, only transform files with actual directives,
      // not files that just match serde patterns (which are internal SDK implementation files)
      const isWorkflowSdkFile = workflowSdkPathPattern.test(id);
      if (isWorkflowSdkFile && !hasDirective) {
        return null;
      }

      if (!hasDirective && !hasSerde) {
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
            plugins: [[swcPlugin, { mode: 'client' }]],
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
