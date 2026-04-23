import { createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';

export interface WorkflowPluginOptions {
  /**
   * Controls whether inline source maps are emitted for workflow bundles.
   * Defaults to `'inline'`. Set to `'disabled'` (or `false`) to omit source
   * maps for smaller bundles at the cost of stack trace readability.
   */
  sourcemap?: boolean | 'inline' | 'disabled';
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
