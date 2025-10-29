import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BaseBuilder } from '@workflow/cli/dist/lib/builders/base-builder.js';
import type { WorkflowConfig } from '@workflow/cli/dist/lib/config/types.js';

const CommonBuildOptions = {
  dirs: ['workflows', 'src/workflows'],
  buildTarget: 'next' as const, // unused in base
  stepsBundlePath: '', // unused in base
  workflowsBundlePath: '', // unused in base
  webhookBundlePath: '', // unused in base
};

export class LocalBuilder extends BaseBuilder {
  constructor(config: Partial<WorkflowConfig>) {
    super({
      ...CommonBuildOptions,
      ...config,
      workingDir: config.workingDir || process.cwd(),
    });
  }

  override async build(): Promise<void> {
    // Find SvelteKit routes directory (src/routes or routes)
    const routesDir = await this.findRoutesDirectory();
    const workflowGeneratedDir = join(routesDir, '.well-known/workflow/v1');

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });

    // Add .gitignore to exclude generated files from version control
    await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');

    // Get workflow and step files to bundle
    const inputFiles = await this.getInputFiles();
    const tsConfig = await this.getTsConfigOptions();

    const options = {
      inputFiles,
      workflowGeneratedDir,
      tsBaseUrl: tsConfig.baseUrl,
      tsPaths: tsConfig.paths,
    };

    // Generate the three SvelteKit route handlers
    await this.buildStepsRoute(options);
    await this.buildWorkflowsRoute(options);
    await this.buildWebhookRoute({ workflowGeneratedDir });
  }

  private async buildStepsRoute({
    inputFiles,
    workflowGeneratedDir,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }) {
    // Create steps route: .well-known/workflow/v1/step/+server.ts
    const stepsRouteDir = join(workflowGeneratedDir, 'step');
    await mkdir(stepsRouteDir, { recursive: true });

    return await this.createStepsBundle({
      format: 'esm',
      inputFiles,
      outfile: join(stepsRouteDir, '+server.ts'),
      externalizeNonSteps: true,
      tsBaseUrl,
      tsPaths,
    });
  }

  private async buildWorkflowsRoute({
    inputFiles,
    workflowGeneratedDir,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }) {
    // Create workflows route: .well-known/workflow/v1/flow/+server.ts
    const workflowsRouteDir = join(workflowGeneratedDir, 'flow');
    await mkdir(workflowsRouteDir, { recursive: true });

    return await this.createWorkflowsBundle({
      format: 'esm',
      outfile: join(workflowsRouteDir, '+server.ts'),
      bundleFinalOutput: false,
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });
  }

  private async buildWebhookRoute({
    workflowGeneratedDir,
  }: {
    workflowGeneratedDir: string;
  }) {
    // Create webhook route: .well-known/workflow/v1/webhook/[token]/+server.ts
    const webhookRouteFile = join(
      workflowGeneratedDir,
      'webhook/[token]/+server.ts'
    );

    return await this.createWebhookBundle({
      outfile: webhookRouteFile,
      bundle: false, // SvelteKit will handle bundling
    });
  }

  private async findRoutesDirectory(): Promise<string> {
    const routesDir = resolve(this.config.workingDir, 'src/routes');
    const rootRoutesDir = resolve(this.config.workingDir, 'routes');

    // Try src/routes first (standard SvelteKit convention)
    try {
      await access(routesDir, constants.F_OK);
      const routesStats = await stat(routesDir);
      if (!routesStats.isDirectory()) {
        throw new Error(`Path exists but is not a directory: ${routesDir}`);
      }
      return routesDir;
    } catch {
      // Try routes as fallback
      try {
        await access(rootRoutesDir, constants.F_OK);
        const rootRoutesStats = await stat(rootRoutesDir);
        if (!rootRoutesStats.isDirectory()) {
          throw new Error(
            `Path exists but is not a directory: ${rootRoutesDir}`
          );
        }
        return rootRoutesDir;
      } catch {
        throw new Error(
          'Could not find SvelteKit routes directory. Expected either "src/routes" or "routes" to exist.'
        );
      }
    }
  }
}
