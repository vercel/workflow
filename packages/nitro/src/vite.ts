import { createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Nitro } from 'nitro/types';
import type {} from 'nitro/vite';
import { join } from 'pathe';
import type { Plugin } from 'vite';
import { LocalBuilder } from './builders.js';
import type { ModuleOptions } from './index.js';
import nitroModule from './index.js';

export function workflow(options?: ModuleOptions): Plugin[] {
  let builder: LocalBuilder;
  let workflowBuildDir: string;
  const enqueue = createBuildQueue();

  // Create a lazy transform plugin that excludes the workflow build directory
  // The exclusion path is set during nitro setup, so we need to defer plugin creation
  const lazyTransformPlugin: Plugin = {
    name: 'workflow:transform',
    transform(code, id) {
      // Delegate to the actual transform plugin with exclusion
      // workflowBuildDir is set during nitro setup before transforms run
      const plugin = workflowTransformPlugin({
        exclude: workflowBuildDir ? [workflowBuildDir] : [],
      });
      return (plugin.transform as Function)?.call(this, code, id);
    },
  };

  return [
    lazyTransformPlugin,
    {
      name: 'workflow:nitro',
      nitro: {
        setup: (nitro: Nitro) => {
          // Capture the workflow build directory for exclusion
          workflowBuildDir = join(nitro.options.buildDir, 'workflow');
          nitro.options.workflow = {
            ...nitro.options.workflow,
            ...options,
            _vite: true,
          };
          if (nitro.options.dev) {
            builder = new LocalBuilder(nitro);
          }
          return nitroModule.setup(nitro);
        },
      },
      // NOTE: This is a workaround because Nitro passes the 404 requests to the dev server to handle.
      // For workflow routes, we override to send an empty body to prevent Hono/Vite's SPA fallback.
      configureServer(server) {
        // Add middleware to intercept 404s on workflow routes before Vite's SPA fallback
        return () => {
          server.middlewares.use((req, res, next) => {
            // Only handle workflow webhook routes
            if (!req.url?.startsWith('/.well-known/workflow/v1/')) {
              return next();
            }

            // Wrap writeHead to ensure we send empty body for 404s
            const originalWriteHead = res.writeHead;
            res.writeHead = function (this: typeof res, ...args: any[]) {
              const statusCode = typeof args[0] === 'number' ? args[0] : 200;

              // NOTE: Workaround because Nitro passes 404 requests to the vite to handle.
              // Causes `webhook route with invalid token` test to fail.
              // For 404s on workflow routes, ensure we're sending the right headers
              if (statusCode === 404) {
                // Set content-length to 0 to prevent Vite from overriding
                res.setHeader('Content-Length', '0');
              }

              // @ts-expect-error - Complex overload signature
              return originalWriteHead.apply(this, args);
            } as any;

            next();
          });
        };
      },
    },
    workflowHotUpdatePlugin({
      builder: () => builder,
      enqueue,
    }),
  ];
}
