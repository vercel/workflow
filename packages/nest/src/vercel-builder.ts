import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createBaseBuilderConfig,
  VercelBuildOutputAPIBuilder,
  type WorkflowAfterBundleHook,
} from '@workflow/builders';
import * as esbuild from 'esbuild';
import { resolveAbsentNestPeers } from './nest-optional-peers.js';
import { normalizeBasePath } from './options.js';

const FLOW_FUNCTION_NAME = '__workflow_nest_flow';
const FLOW_DESTINATION = `/${FLOW_FUNCTION_NAME}`;
const WEBHOOK_DESTINATION = '/.well-known/workflow/v1/webhook/[token]';

export interface HealthMetadata {
  specVersion: number;
  workflowCoreVersion: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The runtime `createVcConfig` falls back to when none is configured. Kept in
 * step with it so the esbuild target and the deployed runtime agree.
 */
const DEFAULT_VERCEL_NODE_RUNTIME = 'nodejs22.x';

const IMPORT_META_SHIM = '__workflowNestImportMeta';

/**
 * Give `import.meta` a working value inside the CommonJS app bundle.
 *
 * The app function is emitted as CJS, where esbuild replaces `import.meta`
 * with `{}`. A NestJS app declared `"type": "module"` — the setup the
 * getting-started guide documents — reaches for `import.meta.url` to build a
 * `createRequire` or to resolve a path next to the module, and gets
 * `undefined`. That throws `ERR_INVALID_ARG_TYPE` at cold start in production,
 * while the build only emits an esbuild warning among the rest of its output.
 *
 * Pointing it at the bundle's own file is the honest answer: after bundling,
 * that is where the code actually lives.
 *
 * @internal Exported for regression tests.
 */
export const importMetaShim = {
  banner:
    `var ${IMPORT_META_SHIM} = { url: require("node:url").pathToFileURL(__filename).href, ` +
    `filename: __filename, dirname: __dirname };`,
  define: { 'import.meta': IMPORT_META_SHIM },
} as const;

/**
 * Translate a Vercel Node runtime (`nodejs20.x`) into an esbuild target
 * (`node20`).
 *
 * The app function is bundled for the runtime it is deployed on. Hardcoding a
 * newer target lets esbuild pass through syntax the deployed Node cannot parse
 * — import attributes are the live example between Node 20 and 22 — and the
 * failure is a `SyntaxError` at cold start with no build-time warning.
 * Anything that is not a recognised Node runtime falls back to the same
 * default `createVcConfig` uses.
 *
 * @internal Exported for regression tests.
 */
export function esbuildTargetForRuntime(runtime: string | undefined): string {
  const match = /^nodejs(\d+)(?:\.\d+)?\.x$/.exec(
    runtime ?? DEFAULT_VERCEL_NODE_RUNTIME
  );
  if (!match) {
    return `node${DEFAULT_VERCEL_NODE_RUNTIME.slice('nodejs'.length, -'.x'.length)}`;
  }
  return `node${match[1]}`;
}

/**
 * Compose the Build Output routes owned by the Nest integration.
 *
 * Dedicated workflow functions must be rewritten explicitly before the Nest
 * catch-all. The public HTTP copy uses a non-dot internal name because Vercel
 * does not resolve a same-path rewrite to the queue-triggered function nested
 * under `.well-known`; those requests otherwise continue into `__nest.func`,
 * which intentionally has no local bundles.
 *
 * @internal Exported for regression tests.
 */
export function createNestVercelRoutes(
  existingRoutes: unknown[],
  appFunctionName: string,
  basePath?: string
): unknown[] {
  const prefix = escapeRegex(normalizeBasePath(basePath));
  const workflowPrefix = `${prefix}/\\.well-known/workflow/v1`;
  // Anchored, like the webhook rewrite the shared builder emits. An unanchored
  // `src` is a substring match, so `/anything/.well-known/workflow/v1/flowers`
  // would be rewritten into the workflow function instead of reaching the
  // NestJS catch-all.
  const workflowRoutes: unknown[] = [
    {
      src: `^${workflowPrefix}/flow$`,
      dest: FLOW_DESTINATION,
    },
  ];

  // The shared builder already emits the unprefixed webhook rewrite. Add the
  // prefixed form when generated callback URLs include a base path.
  if (prefix) {
    workflowRoutes.push({
      src: `^${workflowPrefix}/webhook/([^/]+)$`,
      dest: WEBHOOK_DESTINATION,
    });
  }

  return [
    ...existingRoutes,
    { handle: 'filesystem' },
    ...workflowRoutes,
    {
      src: '/(.*)',
      dest: `/${appFunctionName}`,
      check: true,
    },
  ];
}

/**
 * Create an HTTP-addressable health function for the workflow endpoint.
 *
 * Vercel does not expose a function carrying `experimentalTriggers` over HTTP.
 * Keep the queue consumer isolated in the trigger-protected function and expose
 * only a minimal handler that rejects queue delivery requests.
 *
 * @internal Exported for regression tests.
 */
export async function createHttpFlowFunction(
  functionsDir: string,
  healthMetadata: HealthMetadata
): Promise<void> {
  const source = join(functionsDir, '.well-known/workflow/v1/flow.func');
  const destination = join(functionsDir, `${FLOW_FUNCTION_NAME}.func`);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const config = JSON.parse(
    await readFile(join(source, '.vc-config.json'), 'utf-8')
  );
  delete config.experimentalTriggers;
  await writeFile(
    join(destination, '.vc-config.json'),
    JSON.stringify(config, null, 2)
  );
  await writeFile(join(destination, 'package.json'), '{"type":"module"}\n');
  await writeFile(
    join(destination, 'index.mjs'),
    `const healthCheckCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function healthOnly(request) {
  const url = new URL(request.url);
  const isQueueDelivery =
    request.headers.has('ce-type') ||
    request.headers.has('ce-vqsreceipthandle') ||
    request.headers.has('ce-vqsdeliverycount') ||
    request.headers.has('ce-vqsmessageid');
  if (isQueueDelivery || !url.searchParams.has('__health')) {
    return new Response(null, {
      status: 405,
      headers: { allow: 'POST, OPTIONS, GET, HEAD' },
    });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: healthCheckCorsHeaders,
    });
  }

  return new Response(
    JSON.stringify({
      healthy: true,
      endpoint: url.pathname,
      specVersion: ${JSON.stringify(healthMetadata.specVersion)},
      workflowCoreVersion: ${JSON.stringify(healthMetadata.workflowCoreVersion)},
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...healthCheckCorsHeaders,
      },
    }
  );
}

export const POST = healthOnly;
export const OPTIONS = healthOnly;
export const GET = healthOnly;
export const HEAD = healthOnly;
`
  );
}

/** @internal Exported for regression tests. */
export async function resolveHealthMetadata(
  workingDir: string
): Promise<HealthMetadata> {
  const requireFromApp = createRequire(join(workingDir, 'package.json'));
  const workflowRuntimePath = requireFromApp.resolve('workflow/runtime');
  const requireFromWorkflow = createRequire(workflowRuntimePath);
  const coreRuntimePath = requireFromWorkflow.resolve('@workflow/core/runtime');
  const corePackage = JSON.parse(
    await readFile(resolve(coreRuntimePath, '../../package.json'), 'utf-8')
  );
  const requireFromCore = createRequire(coreRuntimePath);
  const worldPath = requireFromCore.resolve('@workflow/world');
  const world = await import(pathToFileURL(worldPath).href);

  return {
    specVersion: world.SPEC_VERSION_CURRENT,
    workflowCoreVersion: corePackage.version,
  };
}

export interface NestVercelBuilderOptions {
  /**
   * Working directory for the NestJS application.
   * @default process.cwd()
   */
  workingDir?: string;
  /**
   * Directories to scan for workflow files. Scope this to where your
   * workflows live (e.g. `['src/workflows']`) so the workflow bundler does
   * not follow your `app.module.ts` into NestJS/DI internals.
   * @default ['src']
   */
  dirs?: string[];
  /**
   * Path (relative to workingDir) to the serverless entry module for the
   * NestJS app. It must `export default` a Node request handler, e.g. the
   * Express instance from `app.getHttpAdapter().getInstance()`. Because the
   * NestJS app is compiled by `nest build` first, this typically imports the
   * compiled module from `dist/`.
   * @example '_vercel/entry.js'
   */
  entryPoint: string;
  /**
   * Name of the catch-all Build Output function for the NestJS app. Served
   * for every request that is not a workflow route.
   * @default '__nest'
   */
  appFunctionName?: string;
  /**
   * Max duration (seconds) for the NestJS app function.
   * @default 300
   */
  maxDuration?: number;
  /** Vercel runtime, e.g. 'nodejs22.x'. */
  runtime?: string;
  /** esbuild sourcemap mode for workflow bundles. */
  sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';
  /** Runs after the workflow bundles and manifest have been written. */
  onAfterBundle?: WorkflowAfterBundleHook;
  /**
   * Route prefix the app is served under, stamped into the generated flow route
   * so the runtime generates matching callback URLs.
   */
  basePath?: string;
  /**
   * Package specifiers to leave as bare `require()` calls instead of bundling
   * them, in both the app function and the workflow functions.
   *
   * NestJS's own optional peers are handled automatically. This is the escape
   * hatch for everything else that resolves its dependencies at runtime behind
   * a `try`/`catch` — database drivers reached through TypeORM or Knex,
   * optional logger transports, and similar. esbuild cannot know those are
   * optional, so it fails the build on the first one the application has not
   * installed.
   *
   * Externalizing a package the deployed function *does* load leaves it
   * unresolvable at runtime, so only list packages the code path in question
   * never reaches. Supports esbuild's trailing wildcard, e.g. `'oracledb'` or
   * `'@scope/*'`.
   */
  external?: string[];
}

/**
 * Emits a complete Vercel Build Output API directory (`.vercel/output`) for a
 * NestJS app that uses the Workflow SDK.
 *
 * The workflow side (the combined `flow.func` consumer registered with
 * `experimentalTriggers`, the `webhook/[token].func`, the public manifest and
 * routing) is produced by the shared {@link VercelBuildOutputAPIBuilder},
 * exactly the same code path the Nitro/Next/etc. integrations use, so the
 * queue consumer is discovered by VQS the same way. This class only adds the
 * NestJS app itself as the catch-all function and merges the routes.
 */
export class NestVercelBuilder extends VercelBuildOutputAPIBuilder {
  #workingDir: string;
  #entryPoint: string;
  #appFunctionName: string;
  #maxDuration: number;
  #external: string[];

  constructor(options: NestVercelBuilderOptions) {
    const workingDir = options.workingDir ?? process.cwd();
    const dirs = options.dirs ?? ['src'];
    const external = options.external ?? [];
    // Note: unlike the local-dev NestLocalBuilder (whose bundles run inside the
    // app's node_modules), the Build Output functions must be self-contained,
    // so we do NOT externalize the target world; it is bundled into flow.func.
    super({
      ...createBaseBuilderConfig({
        workingDir,
        dirs,
        runtime: options.runtime,
        sourcemap: options.sourcemap,
        onAfterBundle: options.onAfterBundle,
        // A step that imports an application service pulls `@nestjs/common`
        // into the workflow function, and `@nestjs/common` `require()`s its
        // optional peers behind try/catch. Without this the build fails to
        // resolve `class-validator` and friends in any app that does not
        // install them.
        externalPackages: [...resolveAbsentNestPeers(workingDir), ...external],
      }),
      basePath: options.basePath,
      buildTarget: 'vercel-build-output-api',
    });
    this.#workingDir = workingDir;
    this.#entryPoint = options.entryPoint;
    this.#appFunctionName = options.appFunctionName ?? '__nest';
    this.#maxDuration = options.maxDuration ?? 300;
    this.#external = external;
  }

  override async build(): Promise<void> {
    // 1. Emit the workflow functions (flow.func + webhook + manifest + config)
    //    via the shared builder, identical to every other integration.
    await super.build();

    // Vercel queue-triggered functions are not HTTP-addressable. Keep the
    // original flow.func as the VQS consumer and create a separate HTTP health
    // function at a private internal URL for GET/HEAD/OPTIONS requests.
    await createHttpFlowFunction(
      resolve(this.#workingDir, '.vercel/output/functions'),
      await resolveHealthMetadata(this.#workingDir)
    );

    // 2. Bundle the NestJS app as the catch-all function.
    await this.#buildAppFunction();

    // 3. Merge routing so workflow routes + filesystem win before the
    //    catch-all falls through to the NestJS app.
    await this.#mergeRoutes();
  }

  /**
   * Build the esbuild `external` list for the app function.
   *
   * The build toolchain is always external: it is only reachable through
   * WorkflowModule's lazy import when `skipBuild` is false (never on Vercel),
   * so bundling esbuild/SWC/native binaries would only bloat the function.
   *
   * NestJS's optional peers are handled by `resolveAbsentNestPeers`, which
   * externalizes only the ones the app has not installed. Anything else that
   * resolves dependencies at runtime goes through the `external` option.
   */
  #resolveExternals(): string[] {
    return [
      'node:*',
      '@workflow/builders',
      '@swc/core',
      '@swc/core/*',
      '@swc/wasm',
      'esbuild',
      // Native addons are externalized so esbuild does not fail on a `.node`
      // file it cannot bundle. NOTE: this builder does not trace/copy native
      // artifacts into the .func, so an app that actually loads a native addon
      // is not yet supported on Vercel; `#warnAboutNativeAddons` reports the
      // ones it can see, and the README's "Deploying to Vercel" section calls
      // out the limitation.
      '*.node',
      ...resolveAbsentNestPeers(this.#workingDir),
      ...this.#external,
    ];
  }

  /**
   * Report native addons the bundle statically requires.
   *
   * They are externalized so the build succeeds, but nothing copies the `.node`
   * artifact into the function, so the deployed app fails at the first call
   * into the addon — at runtime, in production, with a module-resolution error
   * pointing at a path that only existed on the build machine. Saying so at
   * build time is the difference between a known limitation and a mystery.
   *
   * Only statically analysable requires are visible here. An addon loaded
   * through `bindings()` or `node-gyp-build` computes its path at runtime and
   * esbuild never sees it.
   */
  #warnAboutNativeAddons(addons: Map<string, string>): void {
    if (addons.size === 0) return;
    const listed = [...addons]
      .map(([path, importer]) => `  ${path} (from ${importer})`)
      .join('\n');
    console.warn(
      `[@workflow/nest] This app loads native addons, which are not copied ` +
        `into the deployed function:\n${listed}\n` +
        `  The build succeeds and the deployment fails the first time one is ` +
        `required. Replace them with pure-JS equivalents, or deploy the ` +
        `NestJS app outside the Build Output.`
    );
  }

  /**
   * An esbuild plugin that externalizes `.node` binaries and records them.
   *
   * `external: ['*.node']` alone would also keep the build green, but it does
   * so silently; resolving through a plugin is what makes the report possible.
   */
  #nativeAddonPlugin(found: Map<string, string>): esbuild.Plugin {
    const entryPoint = this.#entryPoint;
    return {
      name: 'workflow-nest-native-addons',
      setup(build) {
        build.onResolve({ filter: /\.node$/ }, (args) => {
          found.set(args.path, args.importer || entryPoint);
          return { path: args.path, external: true };
        });
      },
    };
  }

  async #buildAppFunction(): Promise<void> {
    const outputDir = resolve(this.#workingDir, '.vercel/output');
    const appFuncDir = join(
      outputDir,
      'functions',
      `${this.#appFunctionName}.func`
    );
    await mkdir(appFuncDir, { recursive: true });

    const entryPointPath = resolve(this.#workingDir, this.#entryPoint);

    // The app is already compiled by `nest build` (SWC emits decorator
    // metadata), so esbuild only bundles already-transformed JS. Truly
    // optional NestJS peers are externalized: NestJS `require()`s them behind
    // try/catch, so if unused they are never loaded at runtime.
    const nativeAddons = new Map<string, string>();
    try {
      await esbuild.build({
        entryPoints: [entryPointPath],
        bundle: true,
        platform: 'node',
        target: esbuildTargetForRuntime(this.config.runtime),
        format: 'cjs',
        outfile: join(appFuncDir, 'index.js'),
        external: this.#resolveExternals(),
        plugins: [this.#nativeAddonPlugin(nativeAddons)],
        banner: { js: importMetaShim.banner },
        define: { ...importMetaShim.define },
        keepNames: true,
        logLevel: 'warning',
        sourcemap: false,
        minify: false,
      });
    } catch (error) {
      throw new Error(
        `[@workflow/nest] Could not bundle the NestJS app function from ` +
          `${this.#entryPoint}.\n` +
          `  A package that resolves its dependencies at runtime (a database ` +
          `driver reached through an ORM, an optional logger transport, ...) ` +
          `looks like a hard dependency to the bundler. Pass the ones this ` +
          `app never loads to \`workflow-nest build --external <pkg,pkg>\`.`,
        { cause: error }
      );
    }
    this.#warnAboutNativeAddons(nativeAddons);

    await this.createPackageJson(appFuncDir, 'commonjs');
    await this.createVcConfig(appFuncDir, {
      handler: 'index.js',
      maxDuration: this.#maxDuration,
      runtime: this.config.runtime,
    });
  }

  async #mergeRoutes(): Promise<void> {
    const configPath = resolve(this.#workingDir, '.vercel/output/config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    const existingRoutes: unknown[] = Array.isArray(config.routes)
      ? config.routes
      : [];

    config.routes = createNestVercelRoutes(
      existingRoutes,
      this.#appFunctionName,
      this.config.basePath
    );

    await writeFile(configPath, JSON.stringify(config, null, 2));
  }
}
