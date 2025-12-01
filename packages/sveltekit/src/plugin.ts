import type { HotUpdateOptions, Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';
import { workflowTransformPlugin } from '@workflow/rollup';
import { createBuildQueue } from '@workflow/builders';

export function workflowPlugin(): Plugin[] {
  let builder: SvelteKitBuilder;
  const enqueue = createBuildQueue();

  return [
    workflowTransformPlugin(),
    {
      name: 'workflow:sveltekit',
      configResolved() {
        builder = new SvelteKitBuilder();
      },

      // TODO: Move this to @workflow/vite or something since this is vite specific
      async hotUpdate(options: HotUpdateOptions) {
        const { file, read } = options;

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
          console.log('Workflow file changed, rebuilding...');
          await enqueue(() => builder.build());
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

        console.log('Workflow file changed, rebuilding...');
        await enqueue(() => builder.build());
        // Let Vite handle the normal HMR for the changed file
        return;
      },
    },
  ];
}
