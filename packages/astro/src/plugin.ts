import type { AstroIntegration, HookParameters } from 'astro';
import { LocalBuilder, VercelBuilder } from './builder.js';
import { workflowTransformPlugin } from '@workflow/rollup';
import { createBuildQueue } from '@workflow/builders';

export function workflowPlugin(): AstroIntegration {
  const builder = new LocalBuilder();
  const enqueue = createBuildQueue();

  return {
    name: 'workflow:astro',
    hooks: {
      'astro:config:setup': async ({
        updateConfig,
      }: HookParameters<'astro:config:setup'>) => {
        // Use local builder
        if (!process.env.VERCEL_DEPLOYMENT_ID) {
          try {
            await builder.build();
          } catch (buildError) {
            // Build might fail due to invalid workflow files or missing dependencies
            // Log the error and rethrow to properly propagate to Astro
            console.error('Build failed during config setup:', buildError);
            throw buildError;
          }
        }
        updateConfig({
          vite: {
            plugins: [
              workflowTransformPlugin(),
              {
                name: 'workflow:vite',

                // TODO: Move this to @workflow/vite or something since this is vite specific
                async hotUpdate(options) {
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
            ],
          },
        });
      },
      'astro:build:done': async () => {
        if (process.env.VERCEL_DEPLOYMENT_ID) {
          const vercelBuilder = new VercelBuilder();
          await vercelBuilder.build();
        }
      },
    },
  };
}
