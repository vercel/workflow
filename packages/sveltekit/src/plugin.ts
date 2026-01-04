import type { Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import { createBuildQueue } from '@workflow/builders';

export function workflowPlugin(): Plugin[] {
  let builder = new SvelteKitBuilder();
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
