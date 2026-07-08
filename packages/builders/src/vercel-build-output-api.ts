import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WORKFLOW_ROUTE_BASE } from '@workflow/utils';
import { BaseBuilder } from './base-builder.js';
import { normalizeWorkflowBasePath } from './base-path.js';
import { WORKFLOW_QUEUE_TRIGGER } from './constants.js';
import { escapeRegExp } from './node-module-esbuild-plugin.js';

const WORKFLOW_ROUTE_DIR = WORKFLOW_ROUTE_BASE.slice(1);

/**
 * Route mapping public webhook URLs onto the dynamic `[token]` function.
 * This is the only route the workflow output needs: the flow function is an
 * exact static path that Vercel serves via filesystem matching (functions
 * live below the base path, so the public URL is the function path — and
 * root-relative URLs match nothing, mirroring Next.js basePath behavior).
 * The webhook needs a route because `[token]` is a dynamic segment that
 * arbitrary token URLs can't filesystem-match.
 */
export function createBuildOutputApiWebhookRoute(basePath: string | undefined) {
  const base = normalizeWorkflowBasePath(basePath);
  return {
    src: `^${escapeRegExp(`${base}${WORKFLOW_ROUTE_BASE}`)}/webhook/([^/]+?)/?$`,
    dest: `${base}${WORKFLOW_ROUTE_BASE}/webhook/[token]`,
  };
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
      WORKFLOW_ROUTE_DIR
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
        WORKFLOW_ROUTE_DIR
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
      routes: [createBuildOutputApiWebhookRoute(this.config.basePath)],
    };

    await writeFile(
      join(outputDir, 'config.json'),
      JSON.stringify(buildOutputConfig, null, 2)
    );

    const base = normalizeWorkflowBasePath(this.config.basePath);
    this.logBaseBuilderInfo(`Build Output API created at ${outputDir}`);
    this.logBaseBuilderInfo(
      `Combined function available at ${base}${WORKFLOW_ROUTE_BASE}/flow`
    );
    this.logBaseBuilderInfo(
      `Webhook function available at ${base}${WORKFLOW_ROUTE_BASE}/webhook/[token]`
    );
  }
}
