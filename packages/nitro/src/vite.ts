import type { Plugin } from 'vite'
import type { ModuleOptions } from './index.js'
import type { Nitro } from 'nitro/types';
import { workflowRollupPlugin } from './rollup-plugin.js';
import nitroModule from './index.js'

export function workflow(options?: ModuleOptions): Plugin[] {
  return [
    workflowRollupPlugin(),
    {
      name: 'workflow:nitro',
      // Requires https://github.com/nitrojs/nitro/discussions/3680
      // @ts-ignore
      nitro: {
        setup: (nitro: Nitro) => {
          nitro.options.workflow = { _vite: true, ...nitro.options.workflow, ...options }
          return nitroModule.setup(nitro)
        }
      }
    }
  ]
}
