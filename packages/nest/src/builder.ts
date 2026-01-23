import { mkdir, writeFile } from 'node:fs/promises';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import { join } from 'pathe';

export interface NestBuilderOptions {
  /**
   * Working directory for the NestJS application
   * @default process.cwd()
   */
  workingDir?: string;
  /**
   * Directories to scan for workflow files
   * @default ['src']
   */
  dirs?: string[];
  /**
   * Output directory for generated workflow bundles
   * @default '.nestjs/workflow'
   */
  outDir?: string;
  /**
   * Enable watch mode for development
   * @default false
   */
  watch?: boolean;
}

export class NestLocalBuilder extends BaseBuilder {
  #outDir: string;

  constructor(options: NestBuilderOptions = {}) {
    const workingDir = options.workingDir ?? process.cwd();
    const outDir = options.outDir ?? join(workingDir, '.nestjs/workflow');
    super({
      ...createBaseBuilderConfig({
        workingDir,
        watch: options.watch ?? false,
        dirs: options.dirs ?? ['src'],
      }),
      // Use 'standalone' as base target - we handle the specific bundling ourselves
      buildTarget: 'standalone',
      stepsBundlePath: join(outDir, 'steps.mjs'),
      workflowsBundlePath: join(outDir, 'workflows.mjs'),
      webhookBundlePath: join(outDir, 'webhook.mjs'),
    });
    this.#outDir = outDir;
  }

  get outDir(): string {
    return this.#outDir;
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

    await this.createWebhookBundle({
      outfile: join(this.#outDir, 'webhook.mjs'),
      bundle: false,
    });

    // Generate manifest
    await this.createManifest({
      workflowBundlePath: join(this.#outDir, 'workflows.mjs'),
      manifestDir: this.#outDir,
      manifest,
    });

    // Create .gitignore to exclude generated files
    if (!process.env.VERCEL_DEPLOYMENT_ID) {
      await writeFile(join(this.#outDir, '.gitignore'), '*\n');
    }
  }
}
