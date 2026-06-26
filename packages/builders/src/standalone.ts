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
    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();

    const stepsBundlePath = this.resolvePath(this.config.stepsBundlePath);
    const workflowBundlePath = this.resolvePath(
      this.config.workflowsBundlePath
    );
    await this.ensureDirectory(stepsBundlePath);
    await this.ensureDirectory(workflowBundlePath);

    this.logBaseBuilderInfo('Creating combined bundle');

    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: stepsBundlePath,
      flowOutfile: workflowBundlePath,
      tsconfigPath,
      bundleFinalOutput: true,
    });

    await this.buildWebhookFunction();

    const manifestDir = this.resolvePath('.well-known/workflow/v1');
    await this.createManifest({
      workflowBundlePath,
      manifestDir,
      manifest,
    });

    await this.createClientLibrary();
  }

  private async buildWebhookFunction(): Promise<void> {
    this.logBaseBuilderInfo(
      'Creating webhook bundle at',
      this.config.webhookBundlePath
    );

    const webhookBundlePath = this.resolvePath(this.config.webhookBundlePath);
    await this.ensureDirectory(webhookBundlePath);

    await this.createWebhookBundle({
      outfile: webhookBundlePath,
    });
  }
}
