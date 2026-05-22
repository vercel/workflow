import { createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';

export interface WorkflowPluginOptions {
  /**
   * Controls how source maps are emitted for workflow bundles. Accepts the
   * same values as esbuild's `sourcemap` option: `true`/`'inline'` (default),
   * `'linked'`, `'external'`, `'both'`, or `false` to omit source maps. Can
   * also be set via the `WORKFLOW_SOURCEMAP` environment variable.
   */
  sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';
}

export function workflowPlugin(options: WorkflowPluginOptions = {}): Plugin[] {
  const builder = new SvelteKitBuilder({ sourcemap: options.sourcemap });
  const enqueue = createBuildQueue();

  return [
    workflowTransformPlugin() as Plugin,
    {
      name: 'workflow:sveltekit',
    },
    workflowHotUpdatePlugin({
      builder,
      enqueue,
    }),
  ];
}
