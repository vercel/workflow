import type {} from 'nitro/vite'
import type { Nitro } from 'nitro/types';
import type { Plugin as VitePlugin } from 'vite';
import type { ModuleOptions } from './index.js';
import nitroModule from './index.js';
import { workflowRollupPlugin } from './rollup.js';


export function workflow(options?: ModuleOptions): VitePlugin[] {
  return [
    workflowRollupPlugin() as VitePlugin,
    {
      name: 'workflow:nitro',
      nitro: {
        setup: (nitro: Nitro) => {
          nitro.options.workflow = {
            ...nitro.options.workflow,
            ...options,
            _vite: true,
          };
          return nitroModule.setup(nitro);
        },
      },
    },
  ];
}
