import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  VercelBuildOutputAPIBuilder,
} from '@workflow/builders';
import type { Nitro } from 'nitro/types';
import { join } from 'pathe';

const FLOW_ROUTE = '^\\/\\.well-known\\/workflow\\/v1\\/flow$';
const STEP_ROUTE = '^\\/\\.well-known\\/workflow\\/v1\\/step$';

function getNitroProjectRoot(nitro: Nitro): string {
  return nitro.options.workspaceDir ?? nitro.options.rootDir;
}

function getNitroWorkflowDirs(nitro: Nitro): string[] {
  return nitro.options.workflow?.dirs ?? ['.'];
}

export class VercelBuilder extends VercelBuildOutputAPIBuilder {
  constructor(nitro: Nitro) {
    super({
      ...createBaseBuilderConfig({
        workingDir: nitro.options.rootDir,
        projectRoot: getNitroProjectRoot(nitro),
        dirs: getNitroWorkflowDirs(nitro),
        runtime: nitro.options.workflow?.runtime,
      }),
      buildTarget: 'vercel-build-output-api',
    });
  }
  override async build(): Promise<void> {
    const configPath = join(
      this.config.workingDir,
      '.vercel/output/config.json'
    );
    const originalConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    await super.build();
    const newConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    originalConfig.routes.unshift(
      { src: FLOW_ROUTE, dest: '/.well-known/workflow/v1/flow' },
      { src: STEP_ROUTE, dest: '/.well-known/workflow/v1/step' },
      ...newConfig.routes
    );
    await writeFile(configPath, JSON.stringify(originalConfig, null, 2));
  }
}

export class LocalBuilder extends BaseBuilder {
  #outDir: string;
  constructor(nitro: Nitro) {
    const outDir = join(nitro.options.buildDir, 'workflow');
    super({
      ...createBaseBuilderConfig({
        workingDir: nitro.options.rootDir,
        projectRoot: getNitroProjectRoot(nitro),
        watch: nitro.options.dev,
        dirs: getNitroWorkflowDirs(nitro),
      }),
      buildTarget: 'next', // Placeholder, not actually used
    });
    this.#outDir = outDir;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });

    const { manifest: workflowsManifest } = await this.createWorkflowsBundle({
      outfile: join(this.#outDir, 'workflows.mjs'),
      bundleFinalOutput: false,
      format: 'esm',
      inputFiles,
    });

    const { manifest: stepsManifest } = await this.createStepsBundle({
      outfile: join(this.#outDir, 'steps.mjs'),
      externalizeNonSteps: true,
      // In dev, Nitro dynamically imports the generated workflow files from
      // disk, so there is no later Rollup pass to resolve externalized local
      // TypeScript imports. In prod, Nitro/Rollup handles those imports.
      bundleTransitiveLocalStepDependencies: this.config.watch,
      format: 'esm',
      inputFiles,
    });

    const webhookRouteFile = join(this.#outDir, 'webhook.mjs');

    await this.createWebhookBundle({
      outfile: webhookRouteFile,
      bundle: false,
    });

    // Merge manifests from both bundles
    const manifest = {
      steps: { ...stepsManifest.steps, ...workflowsManifest.steps },
      workflows: { ...stepsManifest.workflows, ...workflowsManifest.workflows },
      classes: { ...stepsManifest.classes, ...workflowsManifest.classes },
    };

    // Generate manifest
    const workflowBundlePath = join(this.#outDir, 'workflows.mjs');
    await this.createManifest({
      workflowBundlePath,
      manifestDir: this.#outDir,
      manifest,
    });
  }
}
