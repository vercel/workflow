import { rm } from 'node:fs/promises';
import { BaseBuilder } from './base-builder.js';
import type { WorkflowConfig } from './types.js';

export class StandaloneBuilder extends BaseBuilder {
  constructor(config: WorkflowConfig) {
    super({
      ...config,
      dirs: ['.'],
    });
  }

  async build(): Promise<void> {
    await Promise.all([
      rm(this.resolvePath('.well-known/workflow/v1/flow.mjs'), {
        force: true,
      }),
      rm(this.resolvePath('.well-known/workflow/v1/step.mjs'), {
        force: true,
      }),
    ]);

    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();

    const stepsBundlePath = this.resolvePath(this.config.stepsBundlePath);
    const workflowBundlePath = this.resolvePath(
      this.config.workflowsBundlePath
    );
    await this.ensureDirectory(stepsBundlePath);
    await this.ensureDirectory(workflowBundlePath);

    console.log('Creating combined bundle');

    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: stepsBundlePath,
      flowOutfile: workflowBundlePath,
      tsconfigPath,
      bundleFinalOutput: true,
    });

    await this.buildWebhookFunction(this.config.webhookBundlePath);
    await this.buildWebhookFunction('./.well-known/workflow/v1/webhook.mjs');

    const manifestDir = this.resolvePath('.well-known/workflow/v1');
    await this.createManifest({
      workflowBundlePath,
      manifestDir,
      manifest,
    });

    await this.createClientLibrary();
  }

  private async buildWebhookFunction(webhookPath: string): Promise<void> {
    console.log('Creating webhook bundle at', webhookPath);

    const webhookBundlePath = this.resolvePath(webhookPath);
    await this.ensureDirectory(webhookBundlePath);

    await this.createWebhookBundle({
      outfile: webhookBundlePath,
    });
  }
}
