import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
  type Provider,
} from '@nestjs/common';
import type { ApplicationConfig } from '@nestjs/core';
import { join } from 'pathe';
import {
  basePathReachesRoutes,
  normalizeBasePath,
  type ResolvedWorkflowModuleOptions,
  resolveModuleOptions,
  setWorkflowBasePath,
  WORKFLOW_MODULE_OPTIONS,
  WORKFLOW_OPTIONS,
  type WorkflowModuleAsyncOptions,
  type WorkflowModuleOptions,
} from './options.js';
import {
  configureWorkflowController,
  WorkflowController,
} from './workflow.controller.js';

export type {
  WorkflowModuleAsyncOptions,
  WorkflowModuleOptions,
} from './options.js';

/**
 * Bundles the controller reads at request time. All three are produced by the
 * same build, so a missing one means the build never ran.
 */
const REQUIRED_BUNDLES = ['steps.mjs', 'workflows.mjs', 'webhook.mjs'] as const;

type WorldLifecycle = {
  start?: () => Promise<void>;
  close?: () => Promise<void>;
};

/**
 * Load the target World from the host application's `workflow` install.
 *
 * `workflow` depends on `@workflow/nest`, not the other way round, so a static
 * import would close a workspace dependency cycle *and* a bare `import()` is
 * not resolvable from this package at all: under a strict `node_modules` layout
 * (pnpm) nothing links `workflow` into `@workflow/nest`'s resolution paths, so
 * the specifier fails with `ERR_MODULE_NOT_FOUND` even though the application
 * one directory up has it installed.
 *
 * Resolving from the application's root is therefore required, not an
 * optimisation. This mirrors `getRuntimeRequire()` in `@workflow/core`.
 */
async function loadWorld(workingDir: string): Promise<WorldLifecycle> {
  const specifier = 'workflow/runtime';
  let resolved: string;
  try {
    resolved = pathToFileURL(
      createRequire(join(workingDir, 'package.json')).resolve(specifier)
    ).href;
  } catch (error) {
    throw new Error(
      `[@workflow/nest] manageWorldLifecycle is enabled but "${specifier}" ` +
        `could not be resolved from ${workingDir}. Install the \`workflow\` ` +
        `package in your application, or set \`workingDir\` to the directory ` +
        `that has it. (${error instanceof Error ? error.message : error})`
    );
  }
  const { getWorld } = (await import(resolved)) as {
    getWorld: () => Promise<WorldLifecycle>;
  };
  return await getWorld();
}

/**
 * Shape the dynamic module both `forRoot` and `forRootAsync` return, so the two
 * entry points cannot drift in what they register or export.
 */
function createDynamicModule(
  providers: Provider[],
  imports?: DynamicModule['imports']
): DynamicModule {
  return {
    module: WorkflowModule,
    imports,
    controllers: [WorkflowController],
    providers: [
      ...providers,
      // Legacy token, kept so existing `@Inject('WORKFLOW_OPTIONS')` call sites
      // keep resolving.
      { provide: WORKFLOW_OPTIONS, useExisting: WORKFLOW_MODULE_OPTIONS },
    ],
    exports: [WORKFLOW_MODULE_OPTIONS, WORKFLOW_OPTIONS],
    global: true,
  };
}

/**
 * NestJS module that serves the `.well-known/workflow/v1` routes and, unless
 * `skipBuild` is set, builds the workflow bundles during startup.
 *
 * The build toolchain (`@workflow/builders`, esbuild, SWC) is imported lazily,
 * only when a build actually runs. Importing this module must stay free of
 * build-time dependencies so the runtime app can be bundled into a serverless
 * function without dragging in the compiler.
 */
@Module({})
export class WorkflowModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(WORKFLOW_MODULE_OPTIONS)
    private readonly options: ResolvedWorkflowModuleOptions,
    @Optional() private readonly appConfig?: ApplicationConfig
  ) {}

  /**
   * Configure the module with static options.
   *
   * @example
   * ```typescript
   * @Module({
   *   imports: [WorkflowModule.forRoot({ basePath: '/api' })],
   * })
   * export class AppModule {}
   * ```
   */
  static forRoot(options: WorkflowModuleOptions = {}): DynamicModule {
    const resolved = resolveModuleOptions(options);
    // The deprecated global keeps working for apps that still call
    // `configureWorkflowController` themselves, and for a controller resolved
    // outside this module's injector.
    configureWorkflowController(resolved.outDir);
    return createDynamicModule([
      { provide: WORKFLOW_MODULE_OPTIONS, useValue: resolved },
    ]);
  }

  /**
   * Configure the module from a factory, so options can come from other
   * providers such as `ConfigService`.
   *
   * @example
   * ```typescript
   * WorkflowModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({
   *     basePath: config.get('API_PREFIX'),
   *   }),
   * })
   * ```
   */
  static forRootAsync(options: WorkflowModuleAsyncOptions): DynamicModule {
    return createDynamicModule(
      [
        {
          provide: WORKFLOW_MODULE_OPTIONS,
          inject: options.inject as never[],
          useFactory: async (...args: never[]) => {
            const resolved = resolveModuleOptions(
              await options.useFactory(...args)
            );
            configureWorkflowController(resolved.outDir);
            return resolved;
          },
        },
      ],
      options.imports as DynamicModule['imports']
    );
  }

  async onModuleInit(): Promise<void> {
    const basePath = this.#resolveEffectiveBasePath();
    setWorkflowBasePath(basePath);

    if (this.options.skipBuild) {
      this.#assertBundlesExist();
    } else {
      await this.#build(basePath);
    }

    if (this.options.manageWorldLifecycle) {
      await this.#startWorld();
    }

    if (this.options.preloadBundles) {
      // Deliberately not awaited: preloading is a latency optimisation, and the
      // controller reports a load failure per request with a better message
      // than a startup crash would give.
      void this.#preloadBundles();
    }
  }

  /**
   * Release the World's resources so the process can exit without being killed.
   *
   * Only reached on a signal when the app calls `app.enableShutdownHooks()`;
   * `app.close()` always triggers it.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.options.manageWorldLifecycle) return;
    try {
      // `getWorld()` caches the instance on `globalThis`, so this is the same
      // World `#startWorld` started rather than a second one.
      const world = await loadWorld(this.options.workingDir);
      await world.close?.();
    } catch (error) {
      console.error('[@workflow/nest] Failed to close the World:', error);
    }
  }

  /**
   * Decide the prefix the SDK should generate workflow URLs under.
   *
   * A global prefix moves the workflow routes without moving the URLs the SDK
   * generates for queue callbacks and webhooks, so every delivery 404s and runs
   * never progress. NestJS runs `onModuleInit` after it has registered routes,
   * which is after `app.setGlobalPrefix()`, so the real prefix is readable here
   * and the two can be reconciled before the first `start()`.
   *
   * With no explicit `basePath` the global prefix is adopted. An explicit
   * `basePath` wins, because it also covers a sub-path that a reverse proxy
   * mounts the app on and NestJS knows nothing about. Such a `basePath` ends
   * *with* the global prefix (`/proxied/api` for a proxy on `/proxied` and a
   * prefix of `/api`), so only a `basePath` that cannot reach the prefixed
   * routes at all is reported; see {@link basePathReachesRoutes}.
   */
  #resolveEffectiveBasePath(): string {
    const globalPrefix = normalizeBasePath(
      this.appConfig?.getGlobalPrefix?.() ?? ''
    );
    const configured = this.options.basePath;

    if (!configured) {
      if (globalPrefix) {
        console.log(
          `[@workflow/nest] Generating workflow URLs under the NestJS global ` +
            `prefix "${globalPrefix}".`
        );
      }
      return globalPrefix;
    }

    if (!basePathReachesRoutes(configured, globalPrefix)) {
      console.error(
        `[@workflow/nest] Global prefix mismatch: NestJS serves the workflow ` +
          `routes under "${globalPrefix}" but basePath is "${configured}". ` +
          `Queue deliveries and webhooks will 404 and runs will not progress. ` +
          `Set \`WorkflowModule.forRoot({ basePath: '${globalPrefix}' })\`, or ` +
          `drop basePath to adopt the global prefix automatically.`
      );
    }
    return configured;
  }

  /**
   * Fail fast when `skipBuild` is set but the bundles were never produced.
   *
   * Without this the application reports a healthy startup and then answers
   * every workflow request with `ERR_MODULE_NOT_FOUND`, which is the shape of a
   * container image built without running `workflow-nest build`.
   *
   * Skipped on Vercel: there the workflow routes are served by the dedicated
   * Build Output functions (`flow.func`, `webhook.func`) that
   * `NestVercelBuilder` emits, not by the in-process `WorkflowController`. The
   * catch-all `__nest.func` that boots this Nest app never contains the
   * local-dev `.nestjs/workflow/*.mjs` bundles, so this assertion would always
   * fail and reject `app.init()`, 500ing every request.
   */
  #assertBundlesExist(): void {
    if (process.env.VERCEL) return;
    const missing = REQUIRED_BUNDLES.filter(
      (name) => !existsSync(join(this.options.outDir, name))
    );
    if (missing.length === 0) return;
    throw new Error(
      `[@workflow/nest] skipBuild is enabled but the workflow bundles are ` +
        `missing from ${this.options.outDir} (${missing.join(', ')}). Run ` +
        `\`workflow-nest build\` as part of your build step, or remove ` +
        `skipBuild so the bundles are built during startup.`
    );
  }

  /**
   * The resolved base path is stamped into the generated flow route, so the
   * bundle republishes it when the route module is evaluated. Without that, a
   * bundle imported after startup would reset the prefix back to the origin
   * root.
   */
  async #build(basePath: string): Promise<void> {
    // Lazy-load the toolchain so it never enters the runtime bundle.
    const [{ NestLocalBuilder }, { createBuildQueue }] = await Promise.all([
      import('./builder.js'),
      import('@workflow/builders'),
    ]);
    const builder = new NestLocalBuilder({ ...this.options, basePath });
    await createBuildQueue()(() => builder.build());
  }

  async #startWorld(): Promise<void> {
    const world = await loadWorld(this.options.workingDir);
    await world.start?.();
  }

  async #preloadBundles(): Promise<void> {
    try {
      const { pathToFileURL } = await import('node:url');
      const url = (name: string) =>
        pathToFileURL(join(this.options.outDir, name)).href;
      await import(url('steps.mjs'));
      await import(url('workflows.mjs'));
    } catch (error) {
      console.warn(
        '[@workflow/nest] Could not preload the workflow bundles; the first ' +
          'request will pay the load cost.',
        error instanceof Error ? error.message : error
      );
    }
  }
}
