import {
  createBuildQueue,
  joinWorkflowBasePath,
  WORKFLOW_ROUTE_BASE,
} from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Nitro } from 'nitro/types';
import type {} from 'nitro/vite';
import { join } from 'pathe';
import type { Plugin } from 'vite';
import { getNitroBasePath, LocalBuilder } from './builders.js';
import type { ModuleOptions } from './index.js';
import nitroModule from './index.js';

export function workflow(options?: ModuleOptions): Plugin[] {
  let builder: LocalBuilder;
  let workflowBuildDir: string;
  const workflowRootRoutePrefix = WORKFLOW_ROUTE_BASE;
  let workflowRoutePrefix = workflowRootRoutePrefix;
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

  const devRoutePlugin: Plugin = {
    name: 'workflow:vite-dev-routes',
    enforce: 'pre',
    // NOTE: This is a workaround because Nitro passes the 404 requests to the
    // dev server to handle. For workflow routes, we override to send an empty
    // body to prevent Hono/Vite's SPA fallback.
    configureServer(server) {
      // Add middleware to intercept workflow routes before Nitro/Vite.
      server.middlewares.use((req, res, next) => {
        const [pathname] = (req.url ?? '').split(/[?#]/, 1);
        if (
          workflowRoutePrefix !== workflowRootRoutePrefix &&
          isWorkflowRoute(pathname, workflowRootRoutePrefix)
        ) {
          res.writeHead(404, { 'Content-Length': '0' });
          res.end();
          return;
        }

        // Only handle workflow routes
        if (!isWorkflowRoute(pathname, workflowRoutePrefix)) {
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
    },
  };

  return [
    lazyTransformPlugin,
    devRoutePlugin,
    {
      name: 'workflow:nitro',
      nitro: {
        setup: (nitro: Nitro) => {
          // Capture the workflow build directory for exclusion
          workflowBuildDir = join(nitro.options.buildDir, 'workflow');
          workflowRoutePrefix = joinWorkflowBasePath(
            getNitroBasePath(nitro),
            workflowRootRoutePrefix
          );
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
    },
    workflowHotUpdatePlugin({
      builder: () => builder,
      enqueue,
    }),
  ];
}

function isWorkflowRoute(pathname: string, routePrefix: string): boolean {
  return pathname === routePrefix || pathname.startsWith(`${routePrefix}/`);
}
