import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AstroConfig, createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { AstroIntegration, HookParameters } from 'astro';
import {
  ASTRO_WORKER_FILE_NAME,
  LocalBuilder,
  VercelBuilder,
} from './builder.js';

/** The worker module's path in the pages directory; see `LocalBuilder`. */
function workerModulePath(srcDir: string): string {
  return join(srcDir, 'pages/.well-known/workflow/v1', ASTRO_WORKER_FILE_NAME);
}

/**
 * The production worker entry: `dist/server/workflow-worker.mjs`, a second
 * entry of the server build whose `startWorkflowWorker()` a start script
 * calls before the server entry, to run the process as a worker for a World
 * that delivers in process (the Postgres World). Astro has no production
 * startup hook (the Node adapter loads even middleware on the first
 * request), so the entry is how a copy of the app that serves no web traffic
 * runs jobs. Emitted as a chunk of the SSR build so it shares the route's
 * modules with the server entry.
 */
function workerEntryPlugin(workerPath: string) {
  let ssr = false;
  return {
    name: 'workflow:astro-worker-entry',
    configResolved(config: { build?: { ssr?: boolean | string } }) {
      ssr = Boolean(config.build?.ssr);
    },
    buildStart(this: {
      emitFile: (file: {
        type: 'chunk';
        id: string;
        fileName: string;
      }) => string;
    }) {
      if (!ssr) return;
      this.emitFile({
        type: 'chunk',
        id: workerPath,
        fileName: 'workflow-worker.mjs',
      });
    },
  };
}

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
  let workerPath: string | undefined;
  const enqueue = createBuildQueue();

  return {
    name: 'workflow:astro',
    hooks: {
      'astro:config:setup': async ({
        config,
        updateConfig,
      }: HookParameters<'astro:config:setup'>) => {
        const srcDir = fileURLToPath(config.srcDir);
        workerPath = workerModulePath(srcDir);
        builderOptions = {
          workingDir: fileURLToPath(config.root),
          dirs: [join(srcDir, 'pages'), join(srcDir, 'workflows')],
          sourcemap: options.sourcemap,
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
            }) as any,
            workerEntryPlugin(workerPath) as any
          );
        }
        updateConfig({
          vite: {
            plugins: vitePlugins,
          },
        });
      },
      // The development server: run it as a worker when the World delivers
      // in process, as the production worker entry does, since Astro has no
      // startup hook of its own for an app to do so. Registering decides:
      // it succeeds only on such a World, and only then is the World started
      // here. The handler loads the route on every delivery, so edits take
      // effect without a restart.
      'astro:server:setup': async ({
        server,
      }: HookParameters<'astro:server:setup'>) => {
        if (process.env.VERCEL_DEPLOYMENT_ID || !workerPath) return;
        try {
          const worker = (await server.ssrLoadModule(workerPath)) as {
            registerWorkflowWorker: () => Promise<boolean>;
            startWorkflowWorker: () => Promise<void>;
          };
          if (await worker.registerWorkflowWorker()) {
            await worker.startWorkflowWorker();
          }
        } catch (error) {
          console.error(
            '[workflow] Could not register the flow route with the World; a ' +
              'World that delivers in process (the Postgres World) runs no ' +
              'worker in this process until it is registered.',
            error instanceof Error ? error.message : error
          );
        }
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
