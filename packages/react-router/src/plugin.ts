import type { Plugin } from 'vite';
import { LocalBuilder } from './builder.js';
import { workflowTransformPlugin } from '@workflow/rollup';
import { createBuildQueue } from '@workflow/builders';
import { workflowHotUpdatePlugin } from '@workflow/vite';

export function workflowPlugin(): Plugin[] {
  const builder = new LocalBuilder();
  const enqueue = createBuildQueue();

  return [
    workflowTransformPlugin(),
    workflowHotUpdatePlugin({
      builder,
      enqueue,
    }) as Plugin,
    {
      name: 'workflow:react-router',

      config(config, { isSsrBuild }) {
        // Only externalize for CLIENT builds to prevent Node.js imports from breaking.
        // SSR builds should bundle everything so all dependencies are included.
        if (isSsrBuild) {
          return {};
        }

        // For client builds, externalize workflow packages to prevent Node.js imports
        // from being bundled. The workflow routes are server-only (API routes).
        return {
          optimizeDeps: {
            exclude: [
              ...(config.optimizeDeps?.exclude ?? []),
              'workflow',
              '@workflow/core',
            ],
          },
          build: {
            rollupOptions: {
              external: [
                ...(Array.isArray(config.build?.rollupOptions?.external)
                  ? config.build.rollupOptions.external
                  : []),
                /^workflow/,
                /^@workflow\//,
                /^node:/,
              ],
            },
          },
        };
      },
    },
  ];
}
