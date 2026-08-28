import { createBuildQueue, type HostModuleResolver } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Nitro } from 'nitro/types';
import type {} from 'nitro/vite';
import type { Plugin, TransformResult } from 'vite';
import { LocalBuilder } from './builders.js';
import type { ModuleOptions } from './index.js';
import nitroModule from './index.js';

/**
 * Vite's plugin container, narrowed to the two hooks the workflow builder
 * needs. Typed structurally so this compiles against Vite versions whose
 * container types differ.
 */
interface VitePluginContainer {
  resolveId(
    id: string,
    importer?: string,
    options?: { ssr: true }
  ): Promise<{ id: string } | null | undefined>;
  load(
    id: string,
    options?: { ssr: true }
  ): Promise<string | { code: string } | null | undefined>;
}

export function workflow(options?: ModuleOptions): Plugin[] {
  let builder: LocalBuilder;
  let devNitro: Nitro | undefined;
  let nitroBuildDir: string;
  const enqueue = createBuildQueue();

  // Populated in `configureServer`. Until then there is no container to ask,
  // which is exactly why the initial dev build is deferred to that point.
  let pluginContainer: VitePluginContainer | undefined;
  let legacyContainer = false;

  /**
   * Last-resort resolver handed to the builder. Held as a stable object so it
   * can be attached at Nitro-setup time and start working once the dev server
   * fills in `pluginContainer`.
   */
  const hostResolver: HostModuleResolver = {
    async resolveId(source, importer) {
      const resolved = await pluginContainer?.resolveId(
        source,
        importer,
        legacyContainer ? { ssr: true } : undefined
      );
      return resolved?.id ?? null;
    },
    async load(id) {
      const loaded = await pluginContainer?.load(
        id,
        legacyContainer ? { ssr: true } : undefined
      );
      if (loaded == null) return null;
      return typeof loaded === 'string' ? loaded : loaded.code;
    },
  };

  // Create a lazy transform plugin that excludes Nitro build artifacts.
  // The exclusion path is set during nitro setup, so we need to defer plugin creation
  const lazyTransformPlugin: Plugin = {
    name: 'workflow:transform',
    transform(code, id, options) {
      // Delegate to the actual transform plugin with exclusion
      // nitroBuildDir is set during nitro setup before transforms run
      const plugin = workflowTransformPlugin({
        exclude: nitroBuildDir ? [nitroBuildDir] : [],
      });
      const transform = plugin.transform as
        | ((
            this: unknown,
            code: string,
            id: string,
            options?: { ssr?: boolean }
          ) => TransformResult | Promise<TransformResult>)
        | undefined;
      return transform?.call(this, code, id, options);
    },
  };

  return [
    lazyTransformPlugin,
    {
      name: 'workflow:nitro',
      nitro: {
        setup: (nitro: Nitro) => {
          // Capture the Nitro build directory for exclusion
          nitroBuildDir = `${nitro.options.buildDir.replace(/[\\/]+$/, '')}/`;
          nitro.options.workflow = {
            ...nitro.options.workflow,
            ...options,
            _vite: true,
            _hostResolver: nitro.options.dev ? hostResolver : undefined,
          };
          if (nitro.options.dev) {
            devNitro = nitro;
            builder = new LocalBuilder(nitro);
          }
          return nitroModule.setup(nitro);
        },
      },
      async buildEnd() {
        const nitro = devNitro;
        devNitro = undefined;
        await nitro?.close();
      },
      buildStart: {
        order: 'post',
        sequential: true,
        handler() {
          // Vite awaits buildStart before listening, after host plugins have
          // initialized. Keep this out of createBuildQueue so startup errors
          // reject server creation instead of being swallowed.
          return pluginContainer ? builder?.build() : undefined;
        },
      },
      // NOTE: This is a workaround because Nitro passes the 404 requests to the dev server to handle.
      // For workflow routes, we override to send an empty body to prevent Hono/Vite's SPA fallback.
      configureServer(server) {
        // The server environment's container resolves module ids reached by
        // server-side steps. The awaited buildStart hook runs the deferred
        // initial build after this container is captured.
        const environment = (server.environments?.nitro ??
          server.environments?.ssr) as
          | { pluginContainer?: VitePluginContainer }
          | undefined;
        // `server.pluginContainer` is the pre-environment-API shape. If
        // neither is present the resolver simply declines everything, which is
        // the behaviour from before this hook existed.
        pluginContainer = environment?.pluginContainer;
        if (!pluginContainer) {
          pluginContainer = (
            server as { pluginContainer?: VitePluginContainer }
          ).pluginContainer;
          legacyContainer = true;
        }

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
