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
    const tsConfig = await this.getTsConfigOptions();

    const options = {
      inputFiles,
      tsBaseUrl: tsConfig.baseUrl,
      tsPaths: tsConfig.paths,
    };
    const manifest = await this.buildStepsBundle(options);
    await this.buildWorkflowsBundle(options);
    await this.buildWebhookFunction();

    // Build unified manifest from workflow bundle
    const workflowBundlePath = this.resolvePath(
      this.config.workflowsBundlePath
    );
    const manifestDir = this.resolvePath('.well-known/workflow/v1');
    await this.createManifest({
      workflowBundlePath,
      manifestDir,
      manifest,
    });

    await this.createClientLibrary();
  }

  private async buildStepsBundle({
    inputFiles,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }) {
    console.log('Creating steps bundle at', this.config.stepsBundlePath);

    const stepsBundlePath = this.resolvePath(this.config.stepsBundlePath);
    await this.ensureDirectory(stepsBundlePath);

    const { manifest } = await this.createStepsBundle({
      outfile: stepsBundlePath,
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });

    return manifest;
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
      'Creating workflows bundle at',
      this.config.workflowsBundlePath
    );

    const workflowBundlePath = this.resolvePath(
      this.config.workflowsBundlePath
    );
    await this.ensureDirectory(workflowBundlePath);

    await this.createWorkflowsBundle({
      outfile: workflowBundlePath,
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });
  }

  private async buildWebhookFunction(): Promise<void> {
    console.log('Creating webhook bundle at', this.config.webhookBundlePath);

    const webhookBundlePath = this.resolvePath(this.config.webhookBundlePath);
    await this.ensureDirectory(webhookBundlePath);

    await this.createWebhookBundle({
      outfile: webhookBundlePath,
    });
  }
}
