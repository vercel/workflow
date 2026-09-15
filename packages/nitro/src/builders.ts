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
 *
 * Note: `externals.external` is on Nitro v2's options shape; v3 dropped it
 * in favor of `noExternals`. Reading it through a v2-shaped view lets us
 * still pick it up on v2 setups; on v3 the chained optional access
 * returns undefined.
 */
type NitroV2ExternalsOptions = { externals?: { external?: unknown[] } };
function getNitroStringExternals(nitro: Nitro): string[] | undefined {
  const external = (nitro.options as NitroV2ExternalsOptions).externals
    ?.external;
  const strings = external?.filter(
    (entry): entry is string => typeof entry === 'string'
  );
  return strings && strings.length > 0 ? strings : undefined;
}

function getNitroProjectRoot(nitro: Nitro): string {
  return nitro.options.workspaceDir ?? nitro.options.rootDir;
}

function getNitroWorkflowDirs(nitro: Nitro): string[] {
  return nitro.options.workflow?.dirs ?? ['.'];
}

export class VercelBuilder extends VercelBuildOutputAPIBuilder {
  constructor(nitro: Nitro) {
    super({
      ...createBaseBuilderConfig({
        workingDir: nitro.options.rootDir,
        projectRoot: getNitroProjectRoot(nitro),
        dirs: getNitroWorkflowDirs(nitro),
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
        projectRoot: getNitroProjectRoot(nitro),
        watch: nitro.options.dev,
        dirs: getNitroWorkflowDirs(nitro),
        sourcemap: nitro.options.workflow?.sourcemap,
        externalPackages: getNitroStringExternals(nitro),
      }),
      buildTarget: 'next', // Placeholder, not actually used
    });
    this.#outDir = outDir;
  }

  /**
   * The dev handler in `../src/index.ts` cache-busts its dynamic import of
   * `workflow/steps.mjs` using the mtime of `workflow/workflows.mjs`, so an
   * unchanged `workflows.mjs` must still be rewritten: a step-body-only edit
   * changes `steps.mjs` alone, and skipping the `workflows.mjs` write would
   * freeze the version key and serve the previous step code until restart.
   *
   * Nothing is lost by opting out. These files are generated into
   * `<buildDir>/workflow`, which no dev server watches, so skipping the write
   * would not have saved a recompile here.
   */
  protected override get skipsUnchangedGeneratedWrites(): boolean {
    return false;
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
    const build = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(this.#outDir, 'steps.mjs'),
      flowOutfile: join(this.#outDir, 'workflows.mjs'),
      format: 'esm',
      // bundleFinalOutput: false, since Nitro externalizes the workflow build
      // dir during dev, and its own rollup pipeline handles bundling for prod.
      // Using true causes "Dynamic require of X is not supported" errors
      // because esbuild wraps CJS require() calls in ESM output.
      bundleFinalOutput: false,
      externalizeNonSteps: true,
      // In dev, Nitro dynamically imports the generated workflow files from
      // disk, so there is no later Rollup pass to resolve externalized local
      // TypeScript imports. In prod, Nitro/Rollup handles those imports.
      bundleTransitiveLocalStepDependencies: this.config.watch,
    });
    const { manifest, stepsContext, interimBundleCtx } = build;

    await Promise.all([stepsContext?.dispose(), interimBundleCtx?.dispose()]);

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
