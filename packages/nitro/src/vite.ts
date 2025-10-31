import type { Plugin } from 'vite'
import { workflowRollupPlugin } from './rollup-plugin.js';
import nitroModule from './index.js'

export function workflow(): Plugin[] {
  return [
    workflowRollupPlugin(),
    {
      name: 'workflow:nitro',
      // @ts-ignore
      nitro: nitroModule
    }
  ]
}
