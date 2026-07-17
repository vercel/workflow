import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
 * NestJS app that uses the Workflow DevKit.
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
      external: [
        'node:*',
        // Workflow build toolchain — only reachable via WorkflowModule's lazy
        // import when skipBuild is false. On Vercel skipBuild is true, so these
        // are never loaded; keeping them external keeps the app bundle free of
        // esbuild/SWC/native binaries.
        '@workflow/builders',
        '@swc/core',
        '@swc/core/*',
        '@swc/wasm',
        'esbuild',
        // Optional NestJS peers — NestJS require()s them behind try/catch, so
        // if unused they are never loaded at runtime.
        '@nestjs/websockets',
        '@nestjs/websockets/*',
        '@nestjs/microservices',
        '@nestjs/microservices/*',
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
        '*.node',
      ],
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
