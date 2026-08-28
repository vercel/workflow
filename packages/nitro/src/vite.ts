import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostModuleResolver } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Nitro } from 'nitro/types';
import type {} from 'nitro/vite';
import type { Plugin } from 'vite';
import type { ModuleOptions } from './index.js';
import nitroModule from './index.js';
import type { ViteModuleIntegration } from './types.js';

/**
 * Vite's plugin container, narrowed to the two hooks the workflow builder
 * needs. Typed structurally so this compiles against Vite versions whose
 * container types differ.
 */
interface ViteResolvedId {
  id: string;
  external?: boolean;
}

interface VitePluginContainer {
  buildStart?(...args: unknown[]): Promise<void>;
  resolveId(
    id: string,
    importer?: string,
    options?: { ssr?: boolean }
  ): Promise<ViteResolvedId | null | undefined>;
  load?(
    id: string,
    options?: { ssr?: boolean }
  ): Promise<string | { code: string } | null | undefined>;
  transform?(
    code: string,
    id: string,
    options?: { ssr?: boolean }
  ): Promise<{ code: string } | null | undefined>;
}

interface ViteModuleNode {
  id?: string | null;
  file?: string | null;
  importedModules?: Set<ViteModuleNode>;
}

interface ViteModuleGraph {
  getModuleById?(id: string): ViteModuleNode | undefined;
  getModulesByFile?(file: string): Set<unknown> | undefined;
  ensureEntryFromUrl(
    id: string,
    legacySsrOrSelfAccepting?: boolean
  ): Promise<ViteModuleNode>;
  invalidateModule?(
    module: unknown,
    seen?: Set<unknown>,
    timestamp?: number,
    isHmr?: boolean
  ): void;
}

interface WorkflowViteEnvironment {
  moduleGraph: ViteModuleGraph;
  pluginContainer: VitePluginContainer;
  transformRequest(id: string): Promise<{ code: string } | null>;
}

interface LegacyViteServer {
  moduleGraph?: ViteModuleGraph;
  pluginContainer?: VitePluginContainer;
}

const WORKFLOW_VITE_ENVIRONMENT = 'workflow_build';

function filePathFromViteId(id: string): string | undefined {
  const cleanId = id.replace(/[?#].*$/, '');
  const file = cleanId.startsWith('file://')
    ? fileURLToPath(cleanId)
    : isAbsolute(cleanId)
      ? cleanId
      : undefined;
  return file?.replace(/\\/g, '/');
}

function invalidateModuleGraphFile(
  graph: ViteModuleGraph | undefined,
  file: string,
  timestamp: number
): void {
  const seen = new Set<unknown>();
  for (const module of graph?.getModulesByFile?.(file) ?? []) {
    graph?.invalidateModule?.(module, seen, timestamp, true);
  }
}

function collectModuleGraphFiles(
  graph: ViteModuleGraph | undefined,
  rootId: string
): Set<string> {
  const files = new Set<string>();
  const root = graph?.getModuleById?.(rootId);
  if (!root) return files;

  const visited = new Set<ViteModuleNode>();
  const queue = [root];
  for (const module of queue) {
    if (visited.has(module)) continue;
    visited.add(module);
    if (module.file) files.add(module.file);
    for (const dependency of module.importedModules ?? []) {
      queue.push(dependency);
    }
  }
  return files;
}

function createTrackedResolver(
  resolve: HostModuleResolver['resolve'],
  invalidate: NonNullable<HostModuleResolver['invalidate']>,
  getDependencies?: (id: string) => Iterable<string>
): HostModuleResolver {
  let dependencies = new Set<string>();
  let currentBuildDependencies: Set<string> | undefined;

  return {
    beginBuild() {
      currentBuildDependencies = new Set();
    },
    endBuild(successful) {
      if (currentBuildDependencies) {
        dependencies = successful
          ? currentBuildDependencies
          : new Set([...dependencies, ...currentBuildDependencies]);
      }
      currentBuildDependencies = undefined;
    },
    async resolve(source, importer) {
      const result = await resolve(source, importer);
      if (result && !result.external) {
        const file = filePathFromViteId(result.id);
        if (file) currentBuildDependencies?.add(file);
        for (const dependency of getDependencies?.(result.id) ?? []) {
          const dependencyFile = filePathFromViteId(dependency);
          if (dependencyFile) currentBuildDependencies?.add(dependencyFile);
        }
      }
      return result;
    },
    isDependency(file) {
      return dependencies.has(file);
    },
    invalidate,
  };
}

function createEnvironmentResolver(
  environment: WorkflowViteEnvironment
): HostModuleResolver {
  const resolve: HostModuleResolver['resolve'] = async (source, importer) => {
    const resolved = await environment.pluginContainer.resolveId(
      source,
      importer
    );
    if (!resolved) return null;
    if (resolved.external) {
      return { id: resolved.id, external: true };
    }

    await environment.moduleGraph.ensureEntryFromUrl(resolved.id);
    const transformed = await environment.transformRequest(resolved.id);
    if (!transformed) {
      throw new Error(
        `Vite resolved "${source}" to "${resolved.id}" but returned no source.`
      );
    }
    return {
      id: resolved.id,
      external: false,
      code: transformed.code,
    };
  };
  return createTrackedResolver(
    resolve,
    (file, timestamp) => {
      invalidateModuleGraphFile(environment.moduleGraph, file, timestamp);
    },
    (id) => collectModuleGraphFiles(environment.moduleGraph, id)
  );
}

async function loadLegacySource(
  pluginContainer: VitePluginContainer,
  resolvedId: string,
  ssr: { ssr: true }
): Promise<string> {
  const loaded = await pluginContainer.load?.(resolvedId, ssr);
  if (typeof loaded === 'string') return loaded;
  if (loaded && typeof loaded.code === 'string') return loaded.code;

  const filePath = filePathFromViteId(resolvedId);
  if (filePath) return readFile(filePath, 'utf8');
  throw new Error(`Vite resolved "${resolvedId}" but returned no source.`);
}

function createLegacyResolver(
  server: LegacyViteServer,
  pluginContainer: VitePluginContainer
): HostModuleResolver {
  const resolve: HostModuleResolver['resolve'] = async (source, importer) => {
    const ssr = { ssr: true } as const;
    const resolved = await pluginContainer.resolveId(source, importer, ssr);
    if (!resolved) return null;
    if (resolved.external) {
      return { id: resolved.id, external: true };
    }

    await server.moduleGraph?.ensureEntryFromUrl(resolved.id, true);
    const code = await loadLegacySource(pluginContainer, resolved.id, ssr);

    const transformed = await pluginContainer.transform?.(
      code,
      resolved.id,
      ssr
    );
    return {
      id: resolved.id,
      external: false,
      code: transformed?.code ?? code,
    };
  };
  return createTrackedResolver(
    resolve,
    (file, timestamp) => {
      invalidateModuleGraphFile(server.moduleGraph, file, timestamp);
    },
    (id) => collectModuleGraphFiles(server.moduleGraph, id)
  );
}

const EMPTY_HOST_RESOLVER: HostModuleResolver = {
  async resolve() {
    return null;
  },
};

const PRESERVE_HOST_IMPORT_RESOLVER: HostModuleResolver = {
  async resolve(source) {
    return { id: source, external: true };
  },
};

export function workflow(options?: ModuleOptions): Plugin[] {
  let devNitro: Nitro | undefined;
  const excludedBuildDirs: string[] = [];
  // Nitro initializes its modules from Vite's raw plugin list before Vite
  // calls config hooks. Production can build workflows during that early
  // phase, so unresolved host imports must be preserved from the outset.
  let activeHostResolver = PRESERVE_HOST_IMPORT_RESOLVER;

  /**
   * Last-resort resolver handed to the builder. Held as a stable object so it
   * can be attached at Nitro-setup time and start working once the dev server
   * fills in `pluginContainer`.
   */
  const hostResolver: HostModuleResolver = {
    resolve(source, importer) {
      return activeHostResolver.resolve(source, importer);
    },
    beginBuild() {
      activeHostResolver.beginBuild?.();
    },
    endBuild(successful) {
      activeHostResolver.endBuild?.(successful);
    },
    isDependency(file) {
      return activeHostResolver.isDependency?.(file) ?? false;
    },
    invalidate(file, timestamp) {
      activeHostResolver.invalidate?.(file, timestamp);
    },
  };
  const integration: ViteModuleIntegration = {
    kind: 'vite',
    hostResolver,
  };

  // The transform plugin keeps the array by reference. Nitro fills it during
  // setup, before Vite transforms any application modules.
  const transformPlugin = workflowTransformPlugin({
    exclude: excludedBuildDirs,
  }) as Plugin;

  return [
    transformPlugin,
    {
      name: 'workflow:nitro',
      config(_config, { command }) {
        if (command !== 'serve') return;
        // Dev output is loaded directly from disk, so unresolved imports may
        // not pass through. Decline them until configureServer provides the
        // live host plugin container.
        activeHostResolver = EMPTY_HOST_RESOLVER;
        return {
          environments: {
            [WORKFLOW_VITE_ENVIRONMENT]: {
              consumer: 'server',
              dev: { moduleRunnerTransform: false },
            },
          },
        };
      },
      nitro: {
        setup: (nitro: Nitro) => {
          // Capture the Nitro build directory for exclusion
          excludedBuildDirs[0] = `${nitro.options.buildDir.replace(/[\\/]+$/, '')}/`;
          nitro.options.workflow = {
            ...nitro.options.workflow,
            ...options,
            _integration: integration,
          };
          if (nitro.options.dev) {
            devNitro = nitro;
          }
          return nitroModule.setup(nitro);
        },
      },
      async buildEnd() {
        const nitro = devNitro;
        devNitro = undefined;
        await nitro?.close();
      },
      // NOTE: This is a workaround because Nitro passes the 404 requests to the dev server to handle.
      // For workflow routes, we override to send an empty body to prevent Hono/Vite's SPA fallback.
      configureServer(server) {
        const environment = server.environments?.[WORKFLOW_VITE_ENVIRONMENT] as
          | WorkflowViteEnvironment
          | undefined;
        if (environment) {
          activeHostResolver = createEnvironmentResolver(environment);
        } else {
          const legacyServer = server as LegacyViteServer;
          const legacyContainer = legacyServer.pluginContainer;
          activeHostResolver = legacyContainer
            ? createLegacyResolver(legacyServer, legacyContainer)
            : EMPTY_HOST_RESOLVER;
        }

        // Vite awaits the client container's buildStart before it finishes
        // creating the server. Wrap that boundary so every host plugin has
        // initialized before the workflow builder asks its resolver for
        // source, regardless of plugin ordering within the post group.
        const clientContainer =
          (server.environments?.client?.pluginContainer as
            | VitePluginContainer
            | undefined) ?? (server as LegacyViteServer).pluginContainer;
        const originalBuildStart =
          clientContainer?.buildStart?.bind(clientContainer);
        if (clientContainer && originalBuildStart) {
          let initialWorkflowBuild: Promise<void> | undefined;
          clientContainer.buildStart = async (...args: unknown[]) => {
            await originalBuildStart(...args);
            initialWorkflowBuild ??= (async () => {
              await environment?.pluginContainer.buildStart?.();
              await integration.builder?.build();
            })();
            await initialWorkflowBuild;
          };
        }

        // Add middleware to intercept 404s on workflow routes before Vite's SPA fallback.
        // Vite does not await post hooks, so this callback must stay synchronous.
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
      builder: () => integration.builder,
    }),
  ];
}
