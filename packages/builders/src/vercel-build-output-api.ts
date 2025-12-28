import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BaseBuilder } from './base-builder.js';
import { STEP_QUEUE_TRIGGER, WORKFLOW_QUEUE_TRIGGER } from './constants.js';

export class VercelBuildOutputAPIBuilder extends BaseBuilder {
  async build(): Promise<void> {
    const outputDir = resolve(this.config.workingDir, '.vercel/output');
    const functionsDir = join(outputDir, 'functions');
    const workflowGeneratedDir = join(functionsDir, '.well-known/workflow/v1');

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });

    const inputFiles = await this.getInputFiles();
    const tsConfig = await this.getTsConfigOptions();
    const options = {
      inputFiles,
      workflowGeneratedDir,
      tsBaseUrl: tsConfig.baseUrl,
      tsPaths: tsConfig.paths,
    };
    const manifest = await this.buildStepsFunction(options);
    await this.buildWorkflowsFunction(options);
    await this.buildWebhookFunction(options);
    await this.createBuildOutputConfig(outputDir);

    // Generate unified manifest
    const workflowBundlePath = join(workflowGeneratedDir, 'flow.func/index.js');
    await this.createManifest({
      workflowBundlePath,
      manifestDir: workflowGeneratedDir,
      manifest,
    });

    await this.createClientLibrary();
  }

  private async buildStepsFunction({
    inputFiles,
    workflowGeneratedDir,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }) {
    console.log('Creating Vercel Build Output API steps function');
    const stepsFuncDir = join(workflowGeneratedDir, 'step.func');
    await mkdir(stepsFuncDir, { recursive: true });

    // Create steps bundle
    const { manifest } = await this.createStepsBundle({
      inputFiles,
      outfile: join(stepsFuncDir, 'index.js'),
      tsBaseUrl,
      tsPaths,
    });

    // Create package.json and .vc-config.json for steps function
    await this.createPackageJson(stepsFuncDir, 'commonjs');
    await this.createVcConfig(stepsFuncDir, {
      shouldAddSourcemapSupport: true,
      experimentalTriggers: [STEP_QUEUE_TRIGGER],
    });

    return manifest;
  }

  private async buildWorkflowsFunction({
    inputFiles,
    workflowGeneratedDir,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }): Promise<void> {
    console.log('Creating Vercel Build Output API workflows function');
    const workflowsFuncDir = join(workflowGeneratedDir, 'flow.func');
    await mkdir(workflowsFuncDir, { recursive: true });

    await this.createWorkflowsBundle({
      outfile: join(workflowsFuncDir, 'index.js'),
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });

    // Create package.json and .vc-config.json for workflows function
    await this.createPackageJson(workflowsFuncDir, 'commonjs');
    await this.createVcConfig(workflowsFuncDir, {
      experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
    });
  }

  private async buildWebhookFunction({
    workflowGeneratedDir,
    bundle = true,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
    bundle?: boolean;
  }): Promise<void> {
    console.log('Creating Vercel Build Output API webhook function');
    const webhookFuncDir = join(workflowGeneratedDir, 'webhook/[token].func');

    // Bundle the webhook route with dependencies resolved
    await this.createWebhookBundle({
      outfile: join(webhookFuncDir, 'index.js'),
      bundle, // Build Output API needs bundling (except in tests)
    });

    // Create package.json and .vc-config.json for webhook function
    await this.createPackageJson(webhookFuncDir, 'commonjs');
    await this.createVcConfig(webhookFuncDir, {
      shouldAddHelpers: false,
    });
  }

  private async createBuildOutputConfig(outputDir: string): Promise<void> {
    // Create config.json for Build Output API
    const buildOutputConfig = {
      version: 3,
      routes: [
        {
          src: '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$',
          dest: '/.well-known/workflow/v1/webhook/[token]',
        },
      ],
    };

    await writeFile(
      join(outputDir, 'config.json'),
      JSON.stringify(buildOutputConfig, null, 2)
    );

    console.log(`Build Output API created at ${outputDir}`);
    console.log('Steps function available at /.well-known/workflow/v1/step');
    console.log(
      'Workflows function available at /.well-known/workflow/v1/flow'
    );
    console.log(
      'Webhook function available at /.well-known/workflow/v1/webhook/[token]'
    );
  }
}
