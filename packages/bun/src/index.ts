import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from '@swc/core';
import { BaseBuilder } from '@workflow/cli/dist/lib/builders/base-builder';
import type { WorkflowConfig } from '@workflow/cli/dist/lib/config/types';
import type { BunPlugin } from 'bun';

export function workflowPlugin(): BunPlugin {
  return {
    name: 'workflow-plugin',
    async setup(build) {
      await new LocalBuilder().build();

      // Client transform plugin - only transform TypeScript files
      // JS files are already built
      build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
        const source = await Bun.file(args.path).text();

        // Optimization: Skip files that do not have any directives
        if (!source.match(/(use step|use workflow)/)) {
          return { contents: source };
        }
        const result = await transform(source, {
          filename: args.path,
          jsc: {
            experimental: {
              plugins: [
                [require.resolve('@workflow/swc-plugin'), { mode: 'client' }],
              ],
            },
          },
        });
        return { contents: result.code, loader: 'ts' };
      });
    },
  };
}

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
