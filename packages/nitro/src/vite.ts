import type { Nitro } from 'nitro/types';
import type { HotUpdateOptions, Plugin } from 'vite';
import type { ModuleOptions } from './index.js';
import nitroModule from './index.js';
import { workflowRollupPlugin } from './rollup.js';

export function workflow(options?: ModuleOptions): Plugin[] {
  return [
    workflowRollupPlugin(),
    {
      name: 'workflow:nitro',
      // Requires https://github.com/nitrojs/nitro/discussions/3680
      // @ts-expect-error
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
          console.log('Workflow file deleted, rebuilding...');
          server.ws.send({
            type: 'full-reload',
            path: '*',
          });
          return;
        }

        const useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m;
        const useStepPattern = /^\s*(['"])use step\1;?\s*$/m;

        if (
          !useWorkflowPattern.test(content) &&
          !useStepPattern.test(content)
        ) {
          return;
        }

        // Trigger full reload - this will cause Nitro's dev:reload hook to fire,
        // which will rebuild workflows and update routes
        console.log('Workflow file changed, rebuilding...');
        server.ws.send({
          type: 'full-reload',
          path: '*',
        });

        // Let Vite handle the normal HMR for the changed file
        return;
      },
    },
  ];
}
