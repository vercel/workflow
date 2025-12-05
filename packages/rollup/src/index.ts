import { relative } from 'node:path';
import { transform } from '@swc/core';
import { resolveModulePath } from 'exsolve';
import type { Plugin } from 'rollup';

export function workflowTransformPlugin(): Plugin {
  return {
    name: 'workflow:transform',
    // This transform applies the "use workflow"/"use step"
    // client transformation
    async transform(code: string, id: string) {
      // only apply the transform if file needs it
      if (!code.match(/(use step|use workflow)/)) {
        return null;
      }

      const isTypeScript = id.endsWith('.ts') || id.endsWith('.tsx');

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
