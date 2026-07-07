import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AstroConfig,
  createBuildQueue,
  createWorkflowBasePathRuntimeCode,
  ensureWorkflowTargetWorldEnv,
  normalizeWorkflowBasePath,
  resolveWorkflowTargetWorldAlias,
  setWorkflowBasePath,
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
        const basePath = normalizeWorkflowBasePath(config.base);
        setWorkflowBasePath(basePath);
        builderOptions = {
          workingDir: fileURLToPath(config.root),
          dirs: [join(srcDir, 'pages'), join(srcDir, 'workflows')],
          sourcemap: options.sourcemap,
          basePath,
        };
        const vitePlugins = [workflowTransformPlugin()];
        if (basePath) {
          vitePlugins.unshift(workflowBasePathPlugin(basePath));
        }
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

/**
 * Injects the base path global into SSR build output so runtime URL
 * generation (queue delivery, webhook URLs) includes the base path.
 *
 * This is just `setWorkflowBasePath(basePath)` delivered into a server
 * bundle we don't own the entry point of: Astro has no boot hook or
 * runtime plugin concept for the compiled server, so a rollup banner is
 * the supported way to run one statement before anything else. A runtime
 * env var would be a second user-facing config that can drift from
 * `config.base`, and a build-time `define` wouldn't reach the read sites:
 * `@workflow/utils` is externalized (not bundled) in Astro's SSR output,
 * so only process-wide state set at boot reliably reaches every reader.
 */
function workflowBasePathPlugin(basePath: string) {
  return {
    name: 'workflow:astro-base-path',
    enforce: 'post',
    configResolved(config: any) {
      if (config.command !== 'build' || !config.build?.ssr) return;
      const banner = createWorkflowBasePathRuntimeCode(basePath);
      const rollupOptions = config.build.rollupOptions;
      rollupOptions.output ??= {};
      const outputs = Array.isArray(rollupOptions.output)
        ? rollupOptions.output
        : [rollupOptions.output];
      for (const output of outputs) {
        output.banner = prependBanner(output.banner, banner);
      }
    },
  };
}

function prependBanner(existing: any, banner: string) {
  if (existing == null) return banner;
  if (typeof existing === 'function') {
    return async (chunk: unknown) => `${banner}\n${await existing(chunk)}`;
  }
  return `${banner}\n${existing}`;
}
