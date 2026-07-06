import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WORKFLOW_ROUTE_BASE } from '@workflow/utils';
import { BaseBuilder } from './base-builder.js';
import {
  createBasePathRouteRegexPrefix,
  joinWorkflowBasePath,
  normalizeWorkflowBasePath,
} from './base-path.js';
import { WORKFLOW_QUEUE_TRIGGER } from './constants.js';

/**
 * Routes that rewrite base-path-prefixed workflow URLs to the internal
 * (root-relative) workflow functions.
 */
export function createBuildOutputApiWorkflowRoutes(basePath?: string) {
  const prefix = createBasePathRouteRegexPrefix(basePath);

  return [
    {
      src: `${prefix}\\.well-known/workflow/v1/flow/?$`,
      dest: `${WORKFLOW_ROUTE_BASE}/flow`,
    },
    {
      src: `${prefix}\\.well-known/workflow/v1/webhook/([^/]+?)/?$`,
      dest: `${WORKFLOW_ROUTE_BASE}/webhook/[token]`,
    },
  ];
}

/**
 * When a base path is configured, block the root-relative workflow endpoints
 * so they are only reachable below the base path (matching Next.js basePath
 * behavior). Returns no routes when no base path is set.
 */
export function createBuildOutputApiRootBlockRoutes(basePath?: string) {
  if (!normalizeWorkflowBasePath(basePath)) return [];

  return [
    { src: '^/\\.well-known/workflow/v1/flow/?$', status: 404 },
    { src: '^/\\.well-known/workflow/v1/webhook/([^/]+?)/?$', status: 404 },
    { src: '^/\\.well-known/workflow/v1/manifest\\.json/?$', status: 404 },
  ];
}

export function getBuildOutputStaticManifestDir(
  outputDir: string,
  basePath?: string
): string {
  return join(
    outputDir,
    'static',
    normalizeWorkflowBasePath(basePath).slice(1),
    '.well-known/workflow/v1'
  );
}

export class VercelBuildOutputAPIBuilder extends BaseBuilder {
  async build(): Promise<void> {
    const outputDir = resolve(this.config.workingDir, '.vercel/output');
    const functionsDir = join(outputDir, 'functions');
    const workflowGeneratedDir = join(functionsDir, '.well-known/workflow/v1');

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });

    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();
    // Create combined bundle in flow.func/
    this.logBaseBuilderInfo(
      'Creating Vercel Build Output API combined function'
    );
    const workflowsFuncDir = join(workflowGeneratedDir, 'flow.func');
    await mkdir(workflowsFuncDir, { recursive: true });

    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(workflowsFuncDir, '__step_registrations.mjs'),
      flowOutfile: join(workflowsFuncDir, 'index.mjs'),
      tsconfigPath,
      bundleFinalOutput: true,
    });

    // Create package.json and .vc-config.json for combined function
    await this.createPackageJson(workflowsFuncDir, 'module');
    await this.createVcConfig(workflowsFuncDir, {
      handler: 'index.mjs',
      // Skip the source-map-support runtime shim when sourcemaps are
      // disabled — it's a meaningful chunk of the function bundle and
      // serves no purpose without maps.
      shouldAddSourcemapSupport: this.sourcemapsEnabled,
      maxDuration: 'max',
      experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
      runtime: this.config.runtime,
    });

    await this.buildWebhookFunction({ workflowGeneratedDir });
    await this.createBuildOutputConfig(outputDir);

    // Generate unified manifest
    const workflowBundlePath = join(
      workflowGeneratedDir,
      'flow.func/index.mjs'
    );
    const manifestJson = await this.createManifest({
      workflowBundlePath,
      manifestDir: workflowGeneratedDir,
      manifest,
    });

    // Expose manifest as a static file when WORKFLOW_PUBLIC_MANIFEST=1.
    // Vercel Build Output API serves static files from .vercel/output/static/
    if (this.shouldExposePublicManifest && manifestJson) {
      const staticManifestDir = getBuildOutputStaticManifestDir(
        outputDir,
        this.config.basePath
      );
      await mkdir(staticManifestDir, { recursive: true });
      if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
        await writeFile(join(staticManifestDir, '.gitignore'), '*');
      }
      await copyFile(
        join(workflowGeneratedDir, 'manifest.json'),
        join(staticManifestDir, 'manifest.json')
      );
    }

    await this.createClientLibrary();
  }

  private async buildWebhookFunction({
    workflowGeneratedDir,
    bundle = true,
  }: {
    workflowGeneratedDir: string;
    bundle?: boolean;
  }): Promise<void> {
    this.logBaseBuilderInfo(
      'Creating Vercel Build Output API webhook function'
    );
    const webhookFuncDir = join(workflowGeneratedDir, 'webhook/[token].func');

    // Bundle the webhook route with dependencies resolved
    await this.createWebhookBundle({
      outfile: join(webhookFuncDir, 'index.mjs'),
      bundle, // Build Output API needs bundling (except in tests)
    });

    // Create package.json and .vc-config.json for webhook function
    await this.createPackageJson(webhookFuncDir, 'module');
    await this.createVcConfig(webhookFuncDir, {
      handler: 'index.mjs',
      shouldAddHelpers: false,
      runtime: this.config.runtime,
    });
  }

  private async createBuildOutputConfig(outputDir: string): Promise<void> {
    // Create config.json for Build Output API
    const buildOutputConfig = {
      version: 3,
      routes: [
        ...createBuildOutputApiRootBlockRoutes(this.config.basePath),
        ...createBuildOutputApiWorkflowRoutes(this.config.basePath),
      ],
    };

    await writeFile(
      join(outputDir, 'config.json'),
      JSON.stringify(buildOutputConfig, null, 2)
    );

    this.logBaseBuilderInfo(`Build Output API created at ${outputDir}`);
    this.logBaseBuilderInfo(
      `Combined function available at ${joinWorkflowBasePath(this.config.basePath, '/.well-known/workflow/v1/flow')}`
    );
    this.logBaseBuilderInfo(
      `Webhook function available at ${joinWorkflowBasePath(this.config.basePath, '/.well-known/workflow/v1/webhook/[token]')}`
    );
  }
}
