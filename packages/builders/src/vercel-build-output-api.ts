import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WORKFLOW_ROUTE_BASE } from '@workflow/utils';
import { BaseBuilder } from './base-builder.js';
import {
  joinWorkflowBasePath,
  normalizeWorkflowBasePath,
} from './base-path.js';
import { WORKFLOW_QUEUE_TRIGGER } from './constants.js';

const REGEXP_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

function createBasePathRouteRegexPrefix(basePath: string | undefined): string {
  const normalized = normalizeWorkflowBasePath(basePath);
  return normalized
    ? `^${normalized.replace(REGEXP_SPECIAL_CHARS, '\\$&')}/`
    : '^/';
}

/**
 * Routes that map the public workflow URLs to the workflow functions. The
 * functions live below the base path, so both `src` and `dest` carry it:
 * root-relative URLs match nothing and 404 naturally, mirroring Next.js
 * basePath behavior.
 */
export function createBuildOutputApiWorkflowRoutes(basePath?: string) {
  const srcPrefix = createBasePathRouteRegexPrefix(basePath);
  const destPrefix = joinWorkflowBasePath(basePath, WORKFLOW_ROUTE_BASE);

  return [
    {
      src: `${srcPrefix}\\.well-known/workflow/v1/flow/?$`,
      dest: `${destPrefix}/flow`,
    },
    {
      src: `${srcPrefix}\\.well-known/workflow/v1/webhook/([^/]+?)/?$`,
      dest: `${destPrefix}/webhook/[token]`,
    },
  ];
}

export class VercelBuildOutputAPIBuilder extends BaseBuilder {
  async build(): Promise<void> {
    const outputDir = resolve(this.config.workingDir, '.vercel/output');
    const functionsDir = join(outputDir, 'functions');
    // Functions live below the base path so the public URLs (and the paths
    // Vercel queue triggers invoke functions at) match the function paths.
    const workflowGeneratedDir = join(
      functionsDir,
      normalizeWorkflowBasePath(this.config.basePath).slice(1),
      '.well-known/workflow/v1'
    );

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
      const staticManifestDir = join(
        outputDir,
        'static',
        normalizeWorkflowBasePath(this.config.basePath).slice(1),
        '.well-known/workflow/v1'
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
      routes: createBuildOutputApiWorkflowRoutes(this.config.basePath),
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
