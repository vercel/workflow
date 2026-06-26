import assert from 'node:assert';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  VercelBuildOutputAPIBuilder,
} from '@workflow/builders';
import type { Nitro } from 'nitro/types';
import { join } from 'pathe';

const FLOW_ROUTE = '^\\/\\.well-known\\/workflow\\/v1\\/flow$';
const STEP_ROUTE = '^\\/\\.well-known\\/workflow\\/v1\\/step$';
const WEBHOOK_ROUTE =
  '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$';
const SERVER_FUNCTIONS = ['__server.func', '__fallback.func'] as const;

export class VercelBuilder extends VercelBuildOutputAPIBuilder {
  constructor(nitro: Nitro) {
    super({
      ...createBaseBuilderConfig({
        workingDir: nitro.options.rootDir,
        dirs: ['.'], // Different apps that use nitro have different directories
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
    const functionsDir = join(
      this.config.workingDir,
      '.vercel/output/functions'
    );
    const workflowFunctionsDir = join(functionsDir, '.well-known/workflow');
    const originalConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    const functionNames = await readdir(functionsDir);
    const serverFunc = SERVER_FUNCTIONS.find((name) =>
      functionNames.includes(name)
    );
    assert(serverFunc);
    const serverDest = `/${serverFunc.replace(/\.func$/, '')}`;
    originalConfig.routes = originalConfig.routes.filter(
      (route: { dest?: string; src?: string }) =>
        !route.src?.includes('.well-known/workflow') &&
        !route.dest?.includes('.well-known/workflow')
    );
    await rm(workflowFunctionsDir, { recursive: true, force: true });
    await super.build();
    originalConfig.routes.unshift(
      { src: FLOW_ROUTE, dest: serverDest },
      { src: STEP_ROUTE, dest: serverDest },
      { src: WEBHOOK_ROUTE, dest: serverDest }
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
        watch: nitro.options.dev,
        dirs: ['.'], // Different apps that use nitro have different directories
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
