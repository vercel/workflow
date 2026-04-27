import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { nodeFileTrace } from '@vercel/nft';
import { BaseBuilder } from './base-builder.js';
import { STEP_QUEUE_TRIGGER, WORKFLOW_QUEUE_TRIGGER } from './constants.js';

type DiscoveredEntries = Awaited<ReturnType<BaseBuilder['discoverEntries']>>;

export class VercelBuildOutputAPIBuilder extends BaseBuilder {
  async build(): Promise<void> {
    const outputDir = resolve(this.config.workingDir, '.vercel/output');
    const functionsDir = join(outputDir, 'functions');
    const workflowGeneratedDir = join(functionsDir, '.well-known/workflow/v1');

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });

    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();
    const discoveredEntries = await this.discoverEntries(
      inputFiles,
      workflowGeneratedDir,
      tsconfigPath
    );
    const options = {
      inputFiles,
      workflowGeneratedDir,
      tsconfigPath,
      discoveredEntries,
    };
    const stepsManifest = await this.buildStepsFunction(options);
    const workflowsManifest = await this.buildWorkflowsFunction(options);
    await this.buildWebhookFunction(options);
    await this.createBuildOutputConfig(outputDir);

    // Merge manifests from both bundles
    const manifest = {
      steps: { ...stepsManifest.steps, ...workflowsManifest.steps },
      workflows: { ...stepsManifest.workflows, ...workflowsManifest.workflows },
      classes: { ...stepsManifest.classes, ...workflowsManifest.classes },
    };

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
        'static/.well-known/workflow/v1'
      );
      await mkdir(staticManifestDir, { recursive: true });
      await copyFile(
        join(workflowGeneratedDir, 'manifest.json'),
        join(staticManifestDir, 'manifest.json')
      );
    }

    await this.createClientLibrary();
  }

  private async buildStepsFunction({
    inputFiles,
    workflowGeneratedDir,
    tsconfigPath,
    discoveredEntries,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsconfigPath?: string;
    discoveredEntries: DiscoveredEntries;
  }) {
    console.log('Creating Vercel Build Output API steps function');
    const stepsFuncDir = join(workflowGeneratedDir, 'step.func');
    await mkdir(stepsFuncDir, { recursive: true });

    // Create steps bundle
    const { manifest } = await this.createStepsBundle({
      inputFiles,
      outfile: join(stepsFuncDir, 'index.mjs'),
      tsconfigPath,
      discoveredEntries,
    });

    // Create package.json and .vc-config.json for steps function
    await this.createPackageJson(stepsFuncDir, 'module');
    await this.createVcConfig(stepsFuncDir, {
      handler: 'index.mjs',
      shouldAddSourcemapSupport: true,
      maxDuration: 'max',
      experimentalTriggers: [STEP_QUEUE_TRIGGER],
      runtime: this.config.runtime,
    });
    await this.traceFunctionDependencies(stepsFuncDir, [
      ...discoveredEntries.discoveredSteps,
      ...discoveredEntries.discoveredSerdeFiles,
      ...this.resolveTraceEntryPoints(['workflow/runtime']),
    ]);

    return manifest;
  }

  private async buildWorkflowsFunction({
    inputFiles,
    workflowGeneratedDir,
    tsconfigPath,
    discoveredEntries,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsconfigPath?: string;
    discoveredEntries: DiscoveredEntries;
  }) {
    console.log('Creating Vercel Build Output API workflows function');
    const workflowsFuncDir = join(workflowGeneratedDir, 'flow.func');
    await mkdir(workflowsFuncDir, { recursive: true });

    const { manifest } = await this.createWorkflowsBundle({
      outfile: join(workflowsFuncDir, 'index.mjs'),
      inputFiles,
      tsconfigPath,
      discoveredEntries,
    });

    // Create package.json and .vc-config.json for workflows function
    await this.createPackageJson(workflowsFuncDir, 'module');
    await this.createVcConfig(workflowsFuncDir, {
      handler: 'index.mjs',
      maxDuration: 'max',
      experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
      runtime: this.config.runtime,
    });
    await this.traceFunctionDependencies(workflowsFuncDir, [
      ...discoveredEntries.discoveredWorkflows,
      ...discoveredEntries.discoveredSerdeFiles,
      ...this.resolveTraceEntryPoints(['workflow/runtime']),
    ]);

    return manifest;
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
    await this.traceFunctionDependencies(
      webhookFuncDir,
      this.resolveTraceEntryPoints(['workflow/api'])
    );
  }

  protected async traceFunctionDependencies(
    functionDir: string,
    entrypoints: string[]
  ): Promise<void> {
    const uniqueEntryPoints = Array.from(new Set(entrypoints)).filter(Boolean);

    if (uniqueEntryPoints.length === 0) {
      return;
    }

    const { fileList } = await nodeFileTrace(uniqueEntryPoints, {
      base: this.config.workingDir,
      processCwd: this.config.workingDir,
    });

    await Promise.all(
      Array.from(fileList, async (file) => {
        const normalizedFile = file.replace(/\\/g, '/');

        if (
          normalizedFile === 'index.mjs' ||
          normalizedFile === 'package.json' ||
          normalizedFile === '.vc-config.json' ||
          normalizedFile === '..' ||
          normalizedFile.startsWith('../') ||
          normalizedFile.startsWith('/')
        ) {
          return;
        }

        const source = resolve(this.config.workingDir, file);
        const target = join(functionDir, file);

        if (source === target) {
          return;
        }

        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, {
          recursive: true,
          force: true,
          dereference: false,
        });
      })
    );
  }

  private resolveTraceEntryPoints(specifiers: string[]): string[] {
    const require = createRequire(join(this.config.workingDir, 'package.json'));
    const resolved: string[] = [];

    for (const specifier of specifiers) {
      try {
        resolved.push(require.resolve(specifier));
      } catch {
        // The normal bundle step reports missing Workflow entry points. This
        // trace pass should not mask that error with a duplicate resolution
        // failure.
      }
    }

    return resolved;
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
