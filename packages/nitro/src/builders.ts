import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
        sourcemap: nitro.options.workflow?.sourcemap,
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
        sourcemap: nitro.options.workflow?.sourcemap,
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

    // V2: The combined bundle's flow route references the steps file by
    // name in its import statement, so we build directly to final names.
    // (The V1 atomic tmp-file pattern doesn't work here because renaming
    // the steps file would leave the flow route's import stale.)
    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(this.#outDir, 'steps.mjs'),
      flowOutfile: join(this.#outDir, 'workflows.mjs'),
      format: 'esm',
      // bundleFinalOutput: false — Nitro externalizes the workflow build dir
      // during dev, and its own rollup pipeline handles bundling for prod.
      // Using true causes "Dynamic require of X is not supported" errors
      // because esbuild wraps CJS require() calls in ESM output.
      bundleFinalOutput: false,
      externalizeNonSteps: true,
    });

    await this.createWebhookBundle({
      outfile: join(this.#outDir, 'webhook.mjs'),
      bundle: false,
    });

    // Generate manifest
    const workflowBundlePath = join(this.#outDir, 'workflows.mjs');
    await this.createManifest({
      workflowBundlePath,
      manifestDir: this.#outDir,
      manifest,
    });
  }
}
