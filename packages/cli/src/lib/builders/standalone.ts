import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BaseBuilder } from './base-builder.js';

export class StandaloneBuilder extends BaseBuilder {
  async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    const tsConfig = await this.getTsConfigOptions();

    const options = {
      inputFiles,
      tsBaseUrl: tsConfig.baseUrl,
      tsPaths: tsConfig.paths,
    };
    await this.buildStepsBundle(options);
    await this.buildWorkflowsBundle(options);
    await this.buildWebhookFunction();

    await this.buildClientLibrary();
  }

  private async buildStepsBundle({
    inputFiles,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }): Promise<void> {
    console.log(
      'Creating Vercel API steps bundle at',
      this.config.stepsBundlePath
    );

    const stepsBundlePath = resolve(
      this.config.workingDir,
      this.config.stepsBundlePath
    );

    // Ensure directory exists
    await mkdir(dirname(stepsBundlePath), { recursive: true });

    await this.createStepsBundle({
      outfile: stepsBundlePath,
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });
  }

  private async buildWorkflowsBundle({
    inputFiles,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }): Promise<void> {
    console.log(
      'Creating vercel API workflows bundle at',
      this.config.workflowsBundlePath
    );

    const workflowBundlePath = resolve(
      this.config.workingDir,
      this.config.workflowsBundlePath
    );

    // Ensure directory exists
    await mkdir(dirname(workflowBundlePath), { recursive: true });

    await this.createWorkflowsBundle({
      outfile: workflowBundlePath,
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });
  }

  private async buildWebhookFunction(): Promise<void> {
    console.log(
      'Creating vercel API webhook bundle at',
      this.config.webhookBundlePath
    );

    const webhookBundlePath = resolve(
      this.config.workingDir,
      this.config.webhookBundlePath
    );

    // Ensure directory exists
    await mkdir(dirname(webhookBundlePath), { recursive: true });

    await this.createWebhookBundle({
      outfile: webhookBundlePath,
    });
  }
}
