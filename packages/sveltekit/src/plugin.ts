import { relative } from 'node:path';
import { transform } from '@swc/core';
import { resolveModulePath } from 'exsolve';
import type { HotUpdateOptions, Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';

export function workflowPlugin(): Plugin {
  let builder: SvelteKitBuilder;

  return {
    name: 'workflow:sveltekit',

    // TODO: Move this to @workflow/vite or something since this is vite specific
    // Transform workflow files with SWC
    async transform(code: string, id: string) {
      // Only apply the transform if file needs it
      if (!code.match(/(use step|use workflow)/)) {
        return null;
      }

      const isTypeScript = id.endsWith('.ts') || id.endsWith('.tsx');
      const isTsx = id.endsWith('.tsx');

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
      if (lowerPath.startsWith(lowerWd + '/')) {
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
            syntax: isTypeScript ? 'typescript' : 'ecmascript',
            tsx: isTsx,
          },
          target: 'es2022',
          experimental: {
            plugins: [[swcPlugin, { mode: 'client' }]],
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

    configResolved() {
      builder = new SvelteKitBuilder();
    },

    // TODO: Move this to @workflow/vite or something since this is vite specific
    async hotUpdate(options: HotUpdateOptions) {
      const { file, server, read } = options;

      // Check if this is a TS/JS file that might contain workflow directives
      const jsTsRegex = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
      if (!jsTsRegex.test(file)) {
        return;
      }

      // Read the file to check for workflow/step directives
      let content: string;
      try {
        content = await read();
      } catch {
        // File might have been deleted - trigger rebuild to update generated routes
        console.log('Workflow file deleted, regenerating routes...');
        try {
          await builder.build();
        } catch (buildError) {
          // Build might fail if files are being deleted during test cleanup
          // Log but don't crash - the next successful change will trigger a rebuild
          console.error('Build failed during file deletion:', buildError);
        }
        return;
      }

      const useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m;
      const useStepPattern = /^\s*(['"])use step\1;?\s*$/m;

      if (!useWorkflowPattern.test(content) && !useStepPattern.test(content)) {
        return;
      }

      // Rebuild everything - simpler and more reliable than tracking individual files
      console.log('Workflow file changed, regenerating routes...');
      try {
        await builder.build();
      } catch (buildError) {
        // Build might fail if files are being modified/deleted during test cleanup
        // Log but don't crash - the next successful change will trigger a rebuild
        console.error('Build failed during HMR:', buildError);
        return;
      }

      // Trigger full reload of workflow routes
      server.ws.send({
        type: 'full-reload',
        path: '*',
      });

      // Let Vite handle the normal HMR for the changed file
      return;
    },
  };
}
