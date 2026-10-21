import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AstroConfig, createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import {
  type WorkflowFlowAssetsPluginOptions,
  workflowFlowAssetsPlugin,
  workflowHotUpdatePlugin,
} from '@workflow/vite';
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
        command,
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

        // Use local builder
        if (!process.env.VERCEL_DEPLOYMENT_ID) {
          const builder = new LocalBuilder({
            ...builderOptions,
            prebuildFlowAssets: command === 'build',
          });
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
            }) as any,
            workflowFlowAssetsPlugin({
              assetsDir: builder.flowAssetsDir,
              emitFile: await getServerAssetEmitter(),
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

/**
 * Astro moves the server build's tracked assets to its public client output.
 * `emitServerAsset()` (newer Astro releases) opts an asset out of that, and
 * out of the static files list. Without it, a plain `emitFile()` asset still
 * stays in the server output, since Astro only moves the assets it tracks.
 */
async function getServerAssetEmitter(): Promise<
  WorkflowFlowAssetsPluginOptions['emitFile']
> {
  try {
    const utils = (await import('astro/assets/utils')) as {
      emitServerAsset?: (
        context: unknown,
        options: { type: 'asset'; fileName: string; source: Uint8Array }
      ) => string;
    };
    const { emitServerAsset } = utils;
    if (typeof emitServerAsset !== 'function') return undefined;
    return (context, file) => {
      emitServerAsset(context, { type: 'asset', ...file });
    };
  } catch {
    return undefined;
  }
}
