import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  VercelBuildOutputAPIBuilder,
} from '@workflow/builders';
import type { Nitro } from 'nitro/types';
import { join } from 'pathe';

export class VercelBuilder extends VercelBuildOutputAPIBuilder {
  constructor(nitro: Nitro) {
    super({
      ...createBaseBuilderConfig({
        workingDir: nitro.options.rootDir,
        dirs: ['.'], // Different apps that use nitro have different directories
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
    originalConfig.routes.unshift(...newConfig.routes);
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

    await this.createWorkflowsBundle({
      outfile: join(this.#outDir, 'workflows.mjs'),
      bundleFinalOutput: false,
      format: 'esm',
      inputFiles,
    });

    const { manifest } = await this.createStepsBundle({
      outfile: join(this.#outDir, 'steps.mjs'),
      externalizeNonSteps: true,
      format: 'esm',
      inputFiles,
    });

    const webhookRouteFile = join(this.#outDir, 'webhook.mjs');

    await this.createWebhookBundle({
      outfile: webhookRouteFile,
      bundle: false,
    });

    // Generate manifest
    const workflowBundlePath = join(this.#outDir, 'workflows.mjs');
    await this.createManifest({
      workflowBundlePath,
      manifestDir: this.#outDir,
      manifest,
    });
  }
}
