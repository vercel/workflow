import type { AstroIntegration, HookParameters } from 'astro';
import { LocalBuilder, VercelBuilder } from './builder.js';
import { workflowTransformPlugin } from '@workflow/rollup';

export function workflow(): AstroIntegration {
  const builder = new LocalBuilder();

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
                    console.log(
                      'Workflow file deleted, regenerating routes...'
                    );
                    try {
                      await builder.build();
                    } catch (buildError) {
                      // Build might fail if files are being deleted during test cleanup
                      // Log but don't crash - the next successful change will trigger a rebuild
                      console.error(
                        'Build failed during file deletion:',
                        buildError
                      );
                    }

                    server.ws.send({ type: 'full-reload', path: '*' });
                    return [];
                  }

                  const useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m;
                  const useStepPattern = /^\s*(['"])use step\1;?\s*$/m;

                  if (
                    !useWorkflowPattern.test(content) &&
                    !useStepPattern.test(content)
                  ) {
                    return;
                  }

                  // Rebuild everything - simpler and more reliable than tracking individual files
                  console.log('Workflow file changed, regenerating routes...');
                  try {
                    await builder.build();
                  } catch (buildError) {
                    // Build might fail if files are being modified/deleted during test cleanup
                    // Log but don't crash - the next successful change will trigger a rebuild
                    console.error('Build failed during HMR:', buildError);
                    return [];
                  }

                  // Trigger full reload of workflow routes
                  server.ws.send({
                    type: 'full-reload',
                    path: '*',
                  });

                  // Prevent Vite from processing this HMR update
                  return [];
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
