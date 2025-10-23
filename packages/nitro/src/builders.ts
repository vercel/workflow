import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseBuilder } from '@workflow/cli/dist/lib/builders/base-builder';
import { VercelBuildOutputAPIBuilder } from '@workflow/cli/dist/lib/builders/vercel-build-output-api';
import type { Nitro } from 'nitro/types';

const CommonBuildOptions = {
  dirs: ['workflows'],
  buildTarget: 'next' as const, // unused in base
  stepsBundlePath: '', // unused in base
  workflowsBundlePath: '', // unused in base
};

export class VercelBuilder extends VercelBuildOutputAPIBuilder {
  constructor(nitro: Nitro) {
    super({
      ...CommonBuildOptions,
      workingDir: nitro.options.rootDir,
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
      ...CommonBuildOptions,
      workingDir: nitro.options.rootDir,
      watch: nitro.options.dev,
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

    await this.createStepsBundle({
      outfile: join(this.#outDir, 'steps.mjs'),
      externalizeNonSteps: true,
      format: 'esm',
      inputFiles,
    });

    await this.createWebhookBundle({
      outfile: join(this.#outDir, 'webhook.mjs'),
      bundle: false,
    });
  }
}
