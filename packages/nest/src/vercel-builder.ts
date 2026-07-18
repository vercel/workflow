import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  createBaseBuilderConfig,
  createWorkflowWorldTargetEsbuildPlugin,
  VercelBuildOutputAPIBuilder,
} from '@workflow/builders';
import * as esbuild from 'esbuild';

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
   * NestJS app. It must `export default` a Node request handler — e.g. the
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
}

/**
 * Emits a complete Vercel Build Output API directory (`.vercel/output`) for a
 * NestJS app that uses the Workflow SDK.
 *
 * The workflow side (the combined `flow.func` consumer registered with
 * `experimentalTriggers`, the `webhook/[token].func`, the public manifest and
 * routing) is produced by the shared {@link VercelBuildOutputAPIBuilder} —
 * exactly the same code path the Nitro/Next/etc. integrations use, so the
 * queue consumer is discovered by VQS the same way. This class only adds the
 * NestJS app itself as the catch-all function and merges the routes.
 */
export class NestVercelBuilder extends VercelBuildOutputAPIBuilder {
  #workingDir: string;
  #entryPoint: string;
  #appFunctionName: string;
  #maxDuration: number;

  constructor(options: NestVercelBuilderOptions) {
    const workingDir = options.workingDir ?? process.cwd();
    const dirs = options.dirs ?? ['src'];
    // Note: unlike the local-dev NestLocalBuilder (whose bundles run inside the
    // app's node_modules), the Build Output functions must be self-contained,
    // so we do NOT externalize the target world — it is bundled into flow.func.
    super({
      ...createBaseBuilderConfig({
        workingDir,
        dirs,
        runtime: options.runtime,
        sourcemap: options.sourcemap,
      }),
      buildTarget: 'vercel-build-output-api',
    });
    this.#workingDir = workingDir;
    this.#entryPoint = options.entryPoint;
    this.#appFunctionName = options.appFunctionName ?? '__nest';
    this.#maxDuration = options.maxDuration ?? 300;
  }

  override async build(): Promise<void> {
    // 1. Emit the workflow functions (flow.func + webhook + manifest + config)
    //    via the shared builder — identical to every other integration.
    await super.build();

    // 2. Bundle the NestJS app as the catch-all function.
    await this.#buildAppFunction();

    // 3. Merge routing so workflow routes + filesystem win before the
    //    catch-all falls through to the NestJS app.
    await this.#mergeRoutes();
  }

  /**
   * Build the esbuild `external` list for the app function.
   *
   * The build toolchain is always external — it is only reachable through
   * WorkflowModule's lazy import when `skipBuild` is false (never on Vercel),
   * so bundling esbuild/SWC/native binaries would only bloat the function.
   *
   * NestJS `require()`s optional peers (validation, transports, cache, …)
   * behind try/catch via its internal `loadPackage`. We externalize such a
   * peer ONLY when it is not installed in the app: an installed peer is one the
   * app actually uses (e.g. `class-validator` for `ValidationPipe`), so it must
   * be bundled into the self-contained function rather than left as a bare
   * `require()` that cannot resolve in the deployed `.func`. Uninstalled peers
   * stay external so esbuild does not fail to resolve them and NestJS's
   * try/catch tolerates their absence at runtime.
   */
  #resolveExternals(): string[] {
    const alwaysExternal = [
      'node:*',
      '@workflow/builders',
      '@swc/core',
      '@swc/core/*',
      '@swc/wasm',
      'esbuild',
      // Native addons are externalized so esbuild does not fail on a `.node`
      // file it cannot bundle. NOTE: this builder does not trace/copy native
      // artifacts into the .func, so an app that actually loads a native addon
      // is not yet supported on Vercel — see the limitation called out in the
      // README's "Deploying to Vercel" section and the changeset.
      '*.node',
    ];

    const optionalPeers = [
      '@nestjs/websockets',
      '@nestjs/microservices',
      '@nestjs/platform-fastify',
      '@nestjs/platform-socket.io',
      'class-validator',
      'class-transformer',
      'cache-manager',
      '@fastify/static',
      '@grpc/grpc-js',
      '@grpc/proto-loader',
      'kafkajs',
      'mqtt',
      'nats',
      'amqplib',
      'amqp-connection-manager',
      'ioredis',
    ];

    const require = createRequire(join(this.#workingDir, 'package.json'));
    const isInstalled = (pkg: string): boolean => {
      try {
        require.resolve(pkg);
        return true;
      } catch {
        return false;
      }
    };

    const externalPeers: string[] = [];
    for (const pkg of optionalPeers) {
      // Installed => bundle it (the app uses it). Not installed => keep external
      // (esbuild won't try to resolve it; NestJS tolerates it being absent).
      if (!isInstalled(pkg)) {
        externalPeers.push(pkg, `${pkg}/*`);
      }
    }

    return [...alwaysExternal, ...externalPeers];
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
    await esbuild.build({
      entryPoints: [entryPointPath],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: join(appFuncDir, 'index.js'),
      external: this.#resolveExternals(),
      keepNames: true,
      logLevel: 'warning',
      sourcemap: false,
      minify: false,
      // Alias @workflow/core/runtime/world-target to the selected world
      // package so start()/getWorld() work inside the app function — the same
      // static world injection the framework plugins apply.
      plugins: [
        createWorkflowWorldTargetEsbuildPlugin({
          workingDir: this.#workingDir,
        }),
      ],
    });

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

    // Keep the workflow webhook rewrite (already written by super.build),
    // then let filesystem routing serve the workflow functions, then fall
    // through to the NestJS app for everything else.
    config.routes = [
      ...existingRoutes,
      { handle: 'filesystem' },
      {
        src: '/(.*)',
        dest: `/${this.#appFunctionName}`,
        check: true,
      },
    ];

    await writeFile(configPath, JSON.stringify(config, null, 2));
  }
}
