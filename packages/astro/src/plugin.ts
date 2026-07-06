import {
  createBuildQueue,
  createWorkflowBasePathRuntimeCode,
  normalizeWorkflowBasePath,
  setWorkflowBasePath,
  WORKFLOW_ROUTE_BASE,
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
  let builder: LocalBuilder | undefined;
  let basePath = '';
  const enqueue = createBuildQueue();

  return {
    name: 'workflow:astro',
    hooks: {
      'astro:config:setup': async ({
        config,
        updateConfig,
      }: HookParameters<'astro:config:setup'>) => {
        basePath = normalizeWorkflowBasePath(config.base);
        setWorkflowBasePath(basePath);
        builder = new LocalBuilder({
          sourcemap: options.sourcemap,
          basePath,
        });

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
              ...(basePath ? [workflowBasePathPlugin(basePath)] : []),
              workflowTransformPlugin(),
              // Cast needed due to Astro using a different internal Vite version
              workflowHotUpdatePlugin({
                builder: () => builder,
                enqueue,
              }) as any,
            ],
          },
        });
      },
      'astro:build:done': async () => {
        if (process.env.VERCEL_DEPLOYMENT_ID) {
          const vercelBuilder = new VercelBuilder({
            sourcemap: options.sourcemap,
            basePath,
          });
          await vercelBuilder.build();
        }
      },
    },
  };
}

/**
 * Makes the base path visible at runtime: injects the base path global into
 * SSR build output, and 404s root-relative workflow routes in the dev server
 * (Astro's dev middleware serves pages at both the base and the root).
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
    configureServer(server: any) {
      return () => {
        server.middlewares.stack.unshift({
          route: '',
          handle: (req: any, res: any, next: () => void) => {
            const path = req.url.split(/[?#]/, 1)[0];
            if (
              path === `${WORKFLOW_ROUTE_BASE}/flow` ||
              path === `${WORKFLOW_ROUTE_BASE}/manifest.json` ||
              path.startsWith(`${WORKFLOW_ROUTE_BASE}/webhook/`)
            ) {
              res.statusCode = 404;
              res.end('Not Found');
              return;
            }

            next();
          },
        });
      };
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
