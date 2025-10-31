import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { transform } from '@swc/core';
import { BaseBuilder } from '@workflow/cli/dist/lib/builders/base-builder';
import type { WorkflowConfig } from '@workflow/cli/dist/lib/config/types';
import type { BunPlugin } from 'bun';

export function workflowPlugin(): BunPlugin {
  return {
    name: 'workflow-plugin',
    async setup(build) {
      // Build workflows on startup
      await new LocalBuilder().build();

      // Client transform plugin
      build.onLoad({ filter: /\.(ts|tsx|js|jsx)$/ }, async (args) => {
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

    await this.createBunWebhookBundle(join(this.#outDir, 'webhook.js'));

    // Add .workflows to .gitignore
    writeFileSync(join(this.#outDir, '.gitignore'), '*\n');
  }

  private async createBunWebhookBundle(outfile: string): Promise<void> {
    console.log('Creating webhook route');
    await mkdir(dirname(outfile), { recursive: true });

    const routeContent = `import { resumeWebhook } from 'workflow/api';

async function handler(request) {
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const token = decodeURIComponent(pathParts[pathParts.length - 1]);

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  try {
    const response = await resumeWebhook(token, request);
    return response;
  } catch (error) {
    console.error('Error during resumeWebhook', error);
    return new Response(null, { status: 404 });
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
`;

    const tempFile = join(dirname(outfile), 'webhook-temp.js');
    writeFileSync(tempFile, routeContent);

    const result = await Bun.build({
      entrypoints: [tempFile],
      outdir: dirname(outfile),
      naming: 'webhook.js',
      target: 'bun',
      format: 'esm',
    });

    if (!result.success) {
      throw new Error('Failed to build webhook bundle');
    }

    // Clean up temp file
    const fs = await import('node:fs');
    fs.unlinkSync(tempFile);
  }
}
