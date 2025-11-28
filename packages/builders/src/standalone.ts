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

    // Build graph manifest from workflow bundle (post-bundle extraction)
    const workflowBundlePath = this.resolvePath('.swc/workflows.js');
    await this.buildGraphManifest({ workflowBundlePath });

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

  private async buildGraphManifest({
    workflowBundlePath,
  }: {
    workflowBundlePath: string;
  }): Promise<void> {
    const graphManifestPath = this.resolvePath('.swc/graph-manifest.json');
    await this.ensureDirectory(graphManifestPath);

    await this.createGraphManifest({
      workflowBundlePath,
      outfile: graphManifestPath,
    });
  }
}
