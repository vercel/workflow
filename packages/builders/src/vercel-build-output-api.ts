import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { type NodeFileTraceReasonType, nodeFileTrace } from '@vercel/nft';
import { pluralize } from '@workflow/utils';
import { type Metafile, transform } from 'esbuild';
import { BaseBuilder } from './base-builder.js';
import { WORKFLOW_QUEUE_TRIGGER } from './constants.js';

/**
 * Files the builder generates at the root of flow.func. Traced runtime
 * assets must never overwrite these.
 */
const GENERATED_FUNCTION_FILES = new Set([
  '.vc-config.json',
  '__step_registrations.mjs',
  '__step_registrations.mjs.map',
  'index.mjs',
  'index.mjs.map',
  'package.json',
]);

const SECRET_FILE_NAMES = new Set(['.env', '.npmrc']);
const SECRET_FILE_EXTENSIONS = new Set(['.key', '.pem']);

/**
 * Credential files must never be copied into the deployed function output,
 * even when runtime code reads them (e.g. dotenv reading `.env`).
 */
function isSecretFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    SECRET_FILE_NAMES.has(name) ||
    name.startsWith('.env.') ||
    SECRET_FILE_EXTENSIONS.has(extname(name))
  );
}

/**
 * Traced files worth copying: nft tags files that code loads from disk at
 * runtime as 'asset' (static analysis of fs reads) or 'sharedlib'
 * (platform-specific shared-library globs). Native addons need their own
 * check — a `.node` file is traced as a plain 'dependency', and the
 * 'sharedlib' glob only catches platform-matching names (a Prisma
 * `.dylib.node` engine traced on Linux gets no 'sharedlib' tag). Everything
 * else nft traces is a regular import that esbuild already inlined.
 */
function isRuntimeAsset(
  file: string,
  reasonTypes: NodeFileTraceReasonType[]
): boolean {
  return (
    file.endsWith('.node') ||
    reasonTypes.some((type) => type === 'asset' || type === 'sharedlib')
  );
}

const TRANSPILE_LOADERS: Record<string, 'ts' | 'tsx' | 'jsx'> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
};

/**
 * nft can only parse plain JavaScript, but app step files are commonly
 * TypeScript/JSX — transpile those before analysis so their runtime asset
 * references are visible.
 */
async function readFileForTrace(
  filePath: string
): Promise<Buffer | string | null> {
  let contents: Buffer;
  try {
    contents = await readFile(filePath);
  } catch {
    return null;
  }
  const loader = TRANSPILE_LOADERS[extname(filePath)];
  if (!loader) return contents;
  try {
    return (await transform(contents.toString(), { loader })).code;
  } catch {
    // Hand nft the raw source; it skips unparseable files with a warning
    // instead of failing the build.
    return contents;
  }
}

export class VercelBuildOutputAPIBuilder extends BaseBuilder {
  async build(): Promise<void> {
    const outputDir = resolve(this.config.workingDir, '.vercel/output');
    const functionsDir = join(outputDir, 'functions');
    const workflowGeneratedDir = join(functionsDir, '.well-known/workflow/v1');

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });

    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();
    // Create combined bundle in flow.func/
    this.logBaseBuilderInfo(
      'Creating Vercel Build Output API combined function'
    );
    const workflowsFuncDir = join(workflowGeneratedDir, 'flow.func');
    await mkdir(workflowsFuncDir, { recursive: true });

    const { manifest, stepsMetafile } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(workflowsFuncDir, '__step_registrations.mjs'),
      flowOutfile: join(workflowsFuncDir, 'index.mjs'),
      tsconfigPath,
      bundleFinalOutput: true,
    });

    await this.copyTracedRuntimeAssets(workflowsFuncDir, stepsMetafile);

    // Create package.json and .vc-config.json for combined function
    await this.createPackageJson(workflowsFuncDir, 'module');
    await this.createVcConfig(workflowsFuncDir, {
      handler: 'index.mjs',
      // Skip the source-map-support runtime shim when sourcemaps are
      // disabled — it's a meaningful chunk of the function bundle and
      // serves no purpose without maps.
      shouldAddSourcemapSupport: this.sourcemapsEnabled,
      maxDuration: 'max',
      experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
      runtime: this.config.runtime,
    });

    await this.buildWebhookFunction({ workflowGeneratedDir });
    await this.createBuildOutputConfig(outputDir);

    // Generate unified manifest
    const workflowBundlePath = join(
      workflowGeneratedDir,
      'flow.func/index.mjs'
    );
    const manifestJson = await this.createManifest({
      workflowBundlePath,
      manifestDir: workflowGeneratedDir,
      manifest,
    });

    // Expose manifest as a static file when WORKFLOW_PUBLIC_MANIFEST=1.
    // Vercel Build Output API serves static files from .vercel/output/static/
    if (this.shouldExposePublicManifest && manifestJson) {
      const staticManifestDir = join(
        outputDir,
        'static/.well-known/workflow/v1'
      );
      await mkdir(staticManifestDir, { recursive: true });
      if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
        await writeFile(join(staticManifestDir, '.gitignore'), '*');
      }
      await copyFile(
        join(workflowGeneratedDir, 'manifest.json'),
        join(staticManifestDir, 'manifest.json')
      );
    }

    await this.createClientLibrary();
  }

  /**
   * Bundling inlines JavaScript, but code often loads files from disk at
   * runtime — Prisma query engines, native addons, WASM, data files. Those
   * files never make it into flow.func, so runtime lookups crash on Vercel
   * (issue #1956).
   *
   * The steps-bundle metafile lists every module esbuild inlined. Tracing
   * those modules with @vercel/nft (at their original on-disk locations,
   * where relative asset references still resolve) surfaces the runtime
   * assets they reference, which are then copied into the function
   * directory so runtime lookups relative to process.cwd() succeed.
   */
  private async copyTracedRuntimeAssets(
    functionDir: string,
    metafile: Metafile | undefined
  ): Promise<void> {
    if (!metafile) return;

    // Metafile input keys are relative to the esbuild working directory.
    // Plugin-virtual modules (e.g. pseudo-packages) and the stdin entry
    // don't exist on disk and are filtered out.
    const entries = Object.keys(metafile.inputs)
      .map((input) => resolve(this.config.workingDir, input))
      .filter((filePath) => existsSync(filePath));
    if (entries.length === 0) return;

    // Trace from the filesystem root so files above the app directory
    // (the pnpm store or hoisted node_modules in monorepos) stay in scope.
    const traceBase = parse(this.config.workingDir).root;
    const { fileList, reasons, warnings } = await nodeFileTrace(entries, {
      base: traceBase,
      processCwd: this.config.workingDir,
      mixedModules: true,
      readFile: readFileForTrace,
    });
    for (const warning of warnings) {
      this.logBaseBuilderInfo(
        `Runtime asset trace warning: ${warning.message}`
      );
    }

    const copied = new Map<string, string>();
    for (const file of fileList) {
      const reason = reasons.get(file);
      if (!reason || !isRuntimeAsset(file, reason.type)) continue;

      const asset = await this.resolveTracedRuntimeAsset(
        functionDir,
        join(traceBase, file)
      );
      if (!asset) continue;

      // Two packages can flatten to the same output path (e.g. nested vs
      // hoisted copies of a package); the first one in trace order wins.
      const existingSource = copied.get(asset.outputPath);
      if (existingSource !== undefined) {
        if (existingSource !== asset.sourcePath) {
          console.warn(
            `Conflicting runtime assets for ${relative(functionDir, asset.outputPath)}: keeping ${existingSource}, skipping ${asset.sourcePath}`
          );
        }
        continue;
      }

      await mkdir(dirname(asset.outputPath), { recursive: true });
      await copyFile(asset.sourcePath, asset.outputPath);
      copied.set(asset.outputPath, asset.sourcePath);
    }

    if (copied.size > 0) {
      this.logBaseBuilderInfo(
        `Copied ${copied.size} traced runtime ${pluralize('asset', 'assets', copied.size)} into the workflow function`
      );
    }
  }

  /**
   * Filters a traced file down to a copyable runtime asset, or null when
   * the file must not be copied.
   */
  private async resolveTracedRuntimeAsset(
    functionDir: string,
    sourcePath: string
  ): Promise<{ sourcePath: string; outputPath: string } | null> {
    if (isSecretFile(sourcePath)) {
      this.logBaseBuilderInfo(
        `Skipping secret-like runtime asset: ${sourcePath}`
      );
      return null;
    }
    // nft can emit directories and symlinks; only regular files are copied
    // (stat follows symlinks to the real contents).
    const stats = await stat(sourcePath).catch(() => null);
    if (!stats?.isFile()) return null;

    const outputPath = this.getRuntimeAssetOutputPath(functionDir, sourcePath);
    if (outputPath === null) {
      console.warn(
        `Skipping runtime asset outside the app directory: ${sourcePath}`
      );
      return null;
    }
    const outputFile = relative(functionDir, outputPath).replace(/\\/g, '/');
    if (GENERATED_FUNCTION_FILES.has(outputFile)) {
      console.warn(
        `Skipping runtime asset that conflicts with the generated function output: ${sourcePath}`
      );
      return null;
    }
    return { sourcePath, outputPath };
  }

  /**
   * Maps a traced runtime asset to its location inside the function
   * directory. Returns null when the asset has no safe location (files
   * outside both node_modules and the app directory).
   */
  private getRuntimeAssetOutputPath(
    functionDir: string,
    sourcePath: string
  ): string | null {
    // Assets inside node_modules keep their path below the innermost
    // node_modules directory. This flattens pnpm/store layouts
    // (node_modules/.pnpm/<pkg>@<v>/node_modules/.prisma/client/engine.node)
    // to the plain layout runtime lookups expect
    // (node_modules/.prisma/client/engine.node), resolved against the
    // function root — which is process.cwd() at runtime.
    const normalizedSource = sourcePath.replace(/\\/g, '/');
    const marker = '/node_modules/';
    const markerIndex = normalizedSource.lastIndexOf(marker);
    if (markerIndex !== -1) {
      return join(
        functionDir,
        'node_modules',
        normalizedSource.slice(markerIndex + marker.length)
      );
    }

    // App files keep their app-directory-relative path: the bundle sits at
    // the function root, which is also process.cwd() at runtime, so
    // cwd-relative reads resolve unchanged.
    const appPath = relative(this.config.workingDir, sourcePath);
    if (
      appPath === '..' ||
      appPath.startsWith(`..${sep}`) ||
      isAbsolute(appPath)
    ) {
      return null;
    }
    return join(functionDir, appPath);
  }

  private async buildWebhookFunction({
    workflowGeneratedDir,
    bundle = true,
  }: {
    workflowGeneratedDir: string;
    bundle?: boolean;
  }): Promise<void> {
    this.logBaseBuilderInfo(
      'Creating Vercel Build Output API webhook function'
    );
    const webhookFuncDir = join(workflowGeneratedDir, 'webhook/[token].func');

    // Bundle the webhook route with dependencies resolved
    await this.createWebhookBundle({
      outfile: join(webhookFuncDir, 'index.mjs'),
      bundle, // Build Output API needs bundling (except in tests)
    });

    // Create package.json and .vc-config.json for webhook function
    await this.createPackageJson(webhookFuncDir, 'module');
    await this.createVcConfig(webhookFuncDir, {
      handler: 'index.mjs',
      shouldAddHelpers: false,
      runtime: this.config.runtime,
    });
  }

  private async createBuildOutputConfig(outputDir: string): Promise<void> {
    // Create config.json for Build Output API
    const buildOutputConfig = {
      version: 3,
      routes: [
        {
          src: '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$',
          dest: '/.well-known/workflow/v1/webhook/[token]',
        },
      ],
    };

    await writeFile(
      join(outputDir, 'config.json'),
      JSON.stringify(buildOutputConfig, null, 2)
    );

    this.logBaseBuilderInfo(`Build Output API created at ${outputDir}`);
    this.logBaseBuilderInfo(
      'Combined function available at /.well-known/workflow/v1/flow'
    );
    this.logBaseBuilderInfo(
      'Webhook function available at /.well-known/workflow/v1/webhook/[token]'
    );
  }
}
