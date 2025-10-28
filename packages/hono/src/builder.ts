import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseBuilder } from '@workflow/cli/dist/lib/builders/base-builder.js';
import { VercelBuildOutputAPIBuilder } from '@workflow/cli/dist/lib/builders/vercel-build-output-api.js';
import type { WorkflowConfig } from '@workflow/cli/dist/lib/config/types.js';

const CommonBuildOptions = {
  dirs: ['workflows'],
  buildTarget: 'next' as const, // unused in base
  stepsBundlePath: '', // unused in base
  workflowsBundlePath: '', // unused in base
  webhookBundlePath: '', // unused in base
};

export class LocalBuilder extends BaseBuilder {
  #outDir: string;

  constructor(config: Partial<WorkflowConfig>) {
    const workingDir = process.cwd();
    const outDir = join(workingDir, '.workflow');
    super({
      ...CommonBuildOptions,
      ...config,
      workingDir,
      clientBundlePath: join(workingDir, '_workflows.js'),
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

    this.buildClientLibrary();
  }
}

// TODO: Implement Vercel builder
export class VercelBuilder extends VercelBuildOutputAPIBuilder {}
