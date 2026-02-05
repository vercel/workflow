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

    const options = {
      inputFiles,
      tsconfigPath,
    };
    const stepsManifest = await this.buildStepsBundle(options);
    const workflowsManifest = await this.buildWorkflowsBundle(options);
    await this.buildWebhookFunction();

    // Merge manifests from both bundles
    // Steps bundle discovers classes from default export conditions
    // Workflow bundle discovers classes from 'workflow' export conditions
    const manifest = this.mergeManifests(stepsManifest, workflowsManifest);

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

  private mergeManifests(
    stepsManifest: {
      steps?: Record<string, any>;
      workflows?: Record<string, any>;
      classes?: Record<string, any>;
    },
    workflowsManifest: {
      steps?: Record<string, any>;
      workflows?: Record<string, any>;
      classes?: Record<string, any>;
    }
  ): {
    steps?: Record<string, any>;
    workflows?: Record<string, any>;
    classes?: Record<string, any>;
  } {
    return {
      steps: { ...stepsManifest.steps, ...workflowsManifest.steps },
      workflows: { ...stepsManifest.workflows, ...workflowsManifest.workflows },
      classes: { ...stepsManifest.classes, ...workflowsManifest.classes },
    };
  }

  private async buildStepsBundle({
    inputFiles,
    tsconfigPath,
  }: {
    inputFiles: string[];
    tsconfigPath?: string;
  }) {
    console.log('Creating steps bundle at', this.config.stepsBundlePath);

    const stepsBundlePath = this.resolvePath(this.config.stepsBundlePath);
    await this.ensureDirectory(stepsBundlePath);

    const { manifest } = await this.createStepsBundle({
      outfile: stepsBundlePath,
      inputFiles,
      tsconfigPath,
    });

    return manifest;
  }

  private async buildWorkflowsBundle({
    inputFiles,
    tsconfigPath,
  }: {
    inputFiles: string[];
    tsconfigPath?: string;
  }) {
    console.log(
      'Creating workflows bundle at',
      this.config.workflowsBundlePath
    );

    const workflowBundlePath = this.resolvePath(
      this.config.workflowsBundlePath
    );
    await this.ensureDirectory(workflowBundlePath);

    const { manifest } = await this.createWorkflowsBundle({
      outfile: workflowBundlePath,
      inputFiles,
      tsconfigPath,
    });

    return manifest;
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
