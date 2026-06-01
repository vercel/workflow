import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BaseBuilder } from './base-builder.js';
import { WORKFLOW_QUEUE_TRIGGER } from './constants.js';

export class VercelBuildOutputAPIBuilder extends BaseBuilder {
  async build(): Promise<void> {
    const outputDir = resolve(this.config.workingDir, '.vercel/output');
    const functionsDir = join(outputDir, 'functions');
    const workflowGeneratedDir = join(functionsDir, '.well-known/workflow/v2');
    const manifestGeneratedDir = join(functionsDir, '.well-known/workflow/v1');

    await Promise.all([
      rm(join(functionsDir, '.well-known/workflow/v1/flow.func'), {
        recursive: true,
        force: true,
      }),
      rm(join(functionsDir, '.well-known/workflow/v1/step.func'), {
        recursive: true,
        force: true,
      }),
      rm(join(functionsDir, '.well-known/workflow/v1/webhook'), {
        recursive: true,
        force: true,
      }),
      rm(join(workflowGeneratedDir, 'manifest.json'), {
        force: true,
      }),
    ]);

    // Ensure output directories exist
    await Promise.all([
      mkdir(workflowGeneratedDir, { recursive: true }),
      mkdir(manifestGeneratedDir, { recursive: true }),
    ]);

    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();
    // Create combined bundle in flow.func/
    console.log('Creating Vercel Build Output API combined function');
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
      manifestDir: manifestGeneratedDir,
      manifest,
    });

    // Expose manifest as a static file when WORKFLOW_PUBLIC_MANIFEST=1.
    // Vercel Build Output API serves static files from .vercel/output/static/
    if (this.shouldExposePublicManifest && manifestJson) {
      const staticManifestDir = join(
        outputDir,
        'static/.well-known/workflow/v1'
      );
      await mkdir(staticManifestDir, { recursive: true });
      if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
        await writeFile(join(staticManifestDir, '.gitignore'), '*');
      }
      await copyFile(
        join(manifestGeneratedDir, 'manifest.json'),
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
    console.log('Creating Vercel Build Output API webhook function');
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
        {
          src: '^\\/\\.well-known\\/workflow\\/v2\\/webhook\\/([^\\/]+)$',
          dest: '/.well-known/workflow/v2/webhook/[token]',
        },
        {
          src: '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$',
          dest: '/.well-known/workflow/v2/webhook/[token]',
        },
      ],
    };

    await writeFile(
      join(outputDir, 'config.json'),
      JSON.stringify(buildOutputConfig, null, 2)
    );

    console.log(`Build Output API created at ${outputDir}`);
    console.log('Combined function available at /.well-known/workflow/v2/flow');
    console.log(
      'Webhook function available at /.well-known/workflow/v2/webhook/[token] (also accepts v1 webhook URLs)'
    );
  }
}
