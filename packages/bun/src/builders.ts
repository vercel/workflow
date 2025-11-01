import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseBuilder } from '@workflow/cli/dist/lib/builders/base-builder';
import type { WorkflowConfig } from '@workflow/cli/dist/lib/config/types';

export class LocalBuilder extends BaseBuilder {
  #outDir: string;
  constructor(config?: Partial<WorkflowConfig>) {
    const outDir = join(config?.workingDir ?? process.cwd(), '.workflows');
    super({
      buildTarget: 'standalone' as const,
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
      dirs: config?.dirs ?? ['./workflows'],
      workingDir: config?.workingDir ?? process.cwd(),
    });
    this.#outDir = outDir;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });

    await this.createWorkflowsBundle({
      outfile: join(this.#outDir, 'workflows.js'),
      bundleFinalOutput: false,
      format: 'esm',
      inputFiles,
    });

    await this.createStepsBundle({
      outfile: join(this.#outDir, 'steps.js'),
      externalizeNonSteps: true,
      format: 'esm',
      inputFiles,
    });

    await this.createWebhookBundle({
      outfile: join(this.#outDir, 'webhook.js'),
      bundle: false,
    });

    console.log('Created webhook bundle');

    // Add .workflows to .gitignore
    writeFileSync(join(this.#outDir, '.gitignore'), '*\n');
  }
}
