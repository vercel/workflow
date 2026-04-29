import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  VercelBuildOutputAPIBuilder,
} from '@workflow/builders';
import type { Nitro } from 'nitro/types';
import { join } from 'pathe';

/**
 * Forward string entries from Nitro's `externals.external` config to the
 * workflow builder's esbuild `external` option. RegExp and function entries
 * are skipped since esbuild's `external` only supports literal strings.
 */
function getNitroStringExternals(nitro: Nitro): string[] | undefined {
  const externals = nitro.options.externals?.external?.filter(
    (entry): entry is string => typeof entry === 'string'
  );
  return externals && externals.length > 0 ? externals : undefined;
}

export class VercelBuilder extends VercelBuildOutputAPIBuilder {
  constructor(nitro: Nitro) {
    super({
      ...createBaseBuilderConfig({
        workingDir: nitro.options.rootDir,
        dirs: ['.'], // Different apps that use nitro have different directories
        runtime: nitro.options.workflow?.runtime,
        externalPackages: getNitroStringExternals(nitro),
      }),
      buildTarget: 'vercel-build-output-api',
    });
  }
  override async build(): Promise<void> {
    const configPath = join(
      this.config.workingDir,
      '.vercel/output/config.json'
    );
    const originalConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    await super.build();
    const newConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    originalConfig.routes.unshift(...newConfig.routes);
    await writeFile(configPath, JSON.stringify(originalConfig, null, 2));
  }
}

export class LocalBuilder extends BaseBuilder {
  #outDir: string;
  constructor(nitro: Nitro) {
    const outDir = join(nitro.options.buildDir, 'workflow');
    super({
      ...createBaseBuilderConfig({
        workingDir: nitro.options.rootDir,
        watch: nitro.options.dev,
        dirs: ['.'], // Different apps that use nitro have different directories
        externalPackages: getNitroStringExternals(nitro),
      }),
      buildTarget: 'next', // Placeholder, not actually used
    });
    this.#outDir = outDir;
  }

  // Serialize concurrent build() calls so overlapping dev rebuilds don't
  // stomp on each other's temp files or partially overwrite output.
  #buildQueue: Promise<void> = Promise.resolve();

  override build(): Promise<void> {
    const next = this.#buildQueue.then(
      () => this.#buildOnce(),
      () => this.#buildOnce()
    );
    // Swallow rejections on the queue itself so a failed build doesn't
    // permanently reject all subsequent builds; each caller still sees
    // its own rejection via the returned promise.
    this.#buildQueue = next.catch(() => {});
    return next;
  }

  async #buildOnce(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });

    // Build to temporary files first, then move them into place.
    // This prevents leaving partial/inconsistent output when a build
    // fails mid-way (e.g., a file was deleted between discovery and
    // compilation during dev HMR). A per-build UUID guarantees uniqueness
    // across concurrent invocations, in case the queue is bypassed.
    const tmpSuffix = `.tmp.${randomUUID()}`;
    const workflowsTmpFile = join(this.#outDir, `workflows${tmpSuffix}.mjs`);
    const stepsTmpFile = join(this.#outDir, `steps${tmpSuffix}.mjs`);
    const webhookTmpFile = join(this.#outDir, `webhook${tmpSuffix}.mjs`);

    try {
      const { manifest: workflowsManifest } = await this.createWorkflowsBundle({
        outfile: workflowsTmpFile,
        bundleFinalOutput: false,
        format: 'esm',
        inputFiles,
      });

      const { manifest: stepsManifest } = await this.createStepsBundle({
        outfile: stepsTmpFile,
        externalizeNonSteps: true,
        format: 'esm',
        inputFiles,
      });

      await this.createWebhookBundle({
        outfile: webhookTmpFile,
        bundle: false,
      });

      // All builds succeeded — atomically move files into place
      await rename(workflowsTmpFile, join(this.#outDir, 'workflows.mjs'));
      await rename(stepsTmpFile, join(this.#outDir, 'steps.mjs'));
      await rename(webhookTmpFile, join(this.#outDir, 'webhook.mjs'));

      // Merge manifests from both bundles
      const manifest = {
        steps: { ...stepsManifest.steps, ...workflowsManifest.steps },
        workflows: {
          ...stepsManifest.workflows,
          ...workflowsManifest.workflows,
        },
        classes: { ...stepsManifest.classes, ...workflowsManifest.classes },
      };

      // Generate manifest
      const workflowBundlePath = join(this.#outDir, 'workflows.mjs');
      await this.createManifest({
        workflowBundlePath,
        manifestDir: this.#outDir,
        manifest,
      });
    } finally {
      // Clean up temporary files on success or failure
      await unlink(workflowsTmpFile).catch(() => {});
      await unlink(stepsTmpFile).catch(() => {});
      await unlink(webhookTmpFile).catch(() => {});
    }
  }
}
