import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BaseBuilder,
  STEP_QUEUE_TRIGGER,
  WORKFLOW_QUEUE_TRIGGER,
} from '@workflow/builders';

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
    await this.buildStepsFunction(options);
    await this.buildWorkflowsFunction(options);
    await this.buildWebhookFunction(options);
    await this.createBuildOutputConfig(outputDir);

    await this.buildClientLibrary();
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
  }): Promise<void> {
    console.log('Creating Vercel Build Output API steps function');
    const stepsFuncDir = join(workflowGeneratedDir, 'step.func');
    await mkdir(stepsFuncDir, { recursive: true });

    // Create steps bundle
    await this.createStepsBundle({
      inputFiles,
      outfile: join(stepsFuncDir, 'index.js'),
      tsBaseUrl,
      tsPaths,
    });

    // Create package.json for CommonJS
    const packageJson = {
      type: 'commonjs',
    };
    await writeFile(
      join(stepsFuncDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // Create .vc-config.json for steps function
    const stepsConfig = {
      runtime: 'nodejs22.x',
      handler: 'index.js',
      launcherType: 'Nodejs',
      architecture: 'arm64',
      shouldAddHelpers: true,
      shouldAddSourcemapSupport: true,
      experimentalTriggers: [STEP_QUEUE_TRIGGER],
    };

    await writeFile(
      join(stepsFuncDir, '.vc-config.json'),
      JSON.stringify(stepsConfig, null, 2)
    );
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

    // Create package.json for ESM support
    const packageJson = {
      type: 'commonjs',
    };
    await writeFile(
      join(workflowsFuncDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // Create .vc-config.json for workflows function
    const workflowsConfig = {
      runtime: 'nodejs22.x',
      handler: 'index.js',
      launcherType: 'Nodejs',
      architecture: 'arm64',
      shouldAddHelpers: true,
      experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
    };

    await writeFile(
      join(workflowsFuncDir, '.vc-config.json'),
      JSON.stringify(workflowsConfig, null, 2)
    );
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

    // Create package.json for CommonJS
    const packageJson = {
      type: 'commonjs',
    };
    await writeFile(
      join(webhookFuncDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // Create .vc-config.json for webhook function
    const webhookConfig = {
      runtime: 'nodejs22.x',
      handler: 'index.js',
      launcherType: 'Nodejs',
      architecture: 'arm64',
      shouldAddHelpers: false,
    };

    await writeFile(
      join(webhookFuncDir, '.vc-config.json'),
      JSON.stringify(webhookConfig, null, 2)
    );
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
