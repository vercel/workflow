import { createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';

export function workflowPlugin(): Plugin[] {
  const builder = new SvelteKitBuilder();
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
