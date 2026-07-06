import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AstroConfig,
  createBuildQueue,
  ensureWorkflowTargetWorldEnv,
  resolveWorkflowTargetWorldAlias,
  WORKFLOW_WORLD_TARGET_MODULE,
} from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { AstroIntegration, HookParameters } from 'astro';
import { LocalBuilder, VercelBuilder } from './builder.js';

export interface WorkflowPluginOptions {
  /**
   * Controls how source maps are emitted for workflow bundles. Accepts the
   * same values as esbuild's `sourcemap` option: `true`/`'inline'` (default),
   * `'linked'`, `'external'`, `'both'`, or `false` to omit source maps. Can
   * also be set via the `WORKFLOW_SOURCEMAP` environment variable.
   */
  sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';
}

export function workflowPlugin(
  options: WorkflowPluginOptions = {}
): AstroIntegration {
  let builderOptions: Partial<AstroConfig> = {
    sourcemap: options.sourcemap,
  };
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
          sourcemap: options.sourcemap,
        };
        const vitePlugins = [workflowTransformPlugin()];
        const workflowTargetWorld = ensureWorkflowTargetWorldEnv();
        const workflowTargetWorldAlias = resolveWorkflowTargetWorldAlias({
          workingDir: process.cwd(),
          targetWorld: workflowTargetWorld,
        });
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
            define: {
              'process.env.WORKFLOW_TARGET_WORLD':
                JSON.stringify(workflowTargetWorld),
            },
            resolve: {
              alias: {
                [WORKFLOW_WORLD_TARGET_MODULE]: workflowTargetWorldAlias,
              },
            },
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
