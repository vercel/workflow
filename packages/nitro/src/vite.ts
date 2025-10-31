import type { Plugin } from 'vite'
import { workflowRollupPlugin } from './rollup-plugin.js';
import nitroModule from './index.js'

export function workflow(): Plugin[] {
  return [
    workflowRollupPlugin(),
    {
      name: 'workflow:nitro',
      // @ts-expect-error https://github.com/nitrojs/nitro/pull/3712
      nitro: nitroModule
    }
  ]
}
