import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AstroConfig, createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { AstroIntegration, HookParameters } from 'astro';
import { LocalBuilder, VercelBuilder } from './builder.js';

export function workflowPlugin(): AstroIntegration {
  let builderOptions: Partial<AstroConfig> = {};
  const enqueue = createBuildQueue();

  return {
    name: 'workflow:astro',
    hooks: {
      'astro:config:setup': async ({
        config,
        updateConfig,
      }: HookParameters<'astro:config:setup'>) => {
        const srcDir = fileURLToPath(config.srcDir);
        builderOptions = {
          workingDir: fileURLToPath(config.root),
          dirs: [join(srcDir, 'pages'), join(srcDir, 'workflows')],
        };
        const vitePlugins = [workflowTransformPlugin()];

        // Use local builder
        if (!process.env.VERCEL_DEPLOYMENT_ID) {
          const builder = new LocalBuilder(builderOptions);
          try {
            await builder.build();
          } catch (buildError) {
            // Build might fail due to invalid workflow files or missing dependencies
            // Log the error and rethrow to properly propagate to Astro
            console.error('Build failed during config setup:', buildError);
            throw buildError;
          }
          vitePlugins.push(
            // Cast needed due to Astro using a different internal Vite version
            workflowHotUpdatePlugin({
              builder,
              enqueue,
            }) as any
          );
        }
        updateConfig({
          vite: {
            plugins: vitePlugins,
          },
        });
      },
      'astro:build:done': async () => {
        if (process.env.VERCEL_DEPLOYMENT_ID) {
          const vercelBuilder = new VercelBuilder(builderOptions);
          await vercelBuilder.build();
        }
      },
    },
  };
}
