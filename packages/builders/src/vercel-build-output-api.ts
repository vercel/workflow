import { existsSync, readFileSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
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
 * Best-effort denylist so common credential files (env files, npm auth,
 * private keys) aren't copied into the deployed function output even when
 * runtime code reads them (e.g. dotenv reading `.env`). Not exhaustive:
 * runtime code legitimately needs most files it reads, so anything not
 * matched here is copied.
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

/**
 * Maps a traced runtime asset to its locations inside the function
 * directory. Runtime lookups resolve against paths recorded at build time
 * (e.g. Prisma bakes the generate-time path of its engine directory
 * relative to cwd), so an asset can be probed at more than one location:
 *
 * - Assets inside node_modules keep their path below the innermost
 *   node_modules directory, which flattens pnpm/store layouts
 *   (node_modules/.pnpm/<pkg>@<v>/node_modules/.prisma/client/engine.node
 *   → node_modules/.prisma/client/engine.node) — the layout npm/yarn-style
 *   lookups probe against the function root (process.cwd() at runtime).
 * - Assets inside the app directory (including a pnpm store nested in the
 *   app's own node_modules, or a Prisma client generated into app source)
 *   also keep their app-relative path, which cwd-relative lookups probe
 *   unchanged.
 * - Assets are also copied at their path relative to each referencing
 *   module's directory: esbuild rewrites __dirname/import.meta.url of
 *   inlined modules to the function root, so a module reading
 *   join(__dirname, 'data/font.afm') probes <functionDir>/data/font.afm
 *   at runtime (e.g. pdfkit's fonts, tiktoken's wasm). References that
 *   escape the function root (join(__dirname, '../data')) cannot be
 *   satisfied and are skipped.
 *
 * Returns an empty list when no location applies.
 */
function getRuntimeAssetOutputPaths(
  functionDir: string,
  sourcePath: string,
  workingDir: string,
  parentDirs: string[]
): string[] {
  const outputPaths = new Set<string>();

  const normalizedSource = sourcePath.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const markerIndex = normalizedSource.lastIndexOf(marker);
  if (markerIndex !== -1) {
    outputPaths.add(
      join(
        functionDir,
        'node_modules',
        normalizedSource.slice(markerIndex + marker.length)
      )
    );
  }

  const appPath = relative(workingDir, sourcePath);
  if (
    appPath !== '..' &&
    !appPath.startsWith(`..${sep}`) &&
    !isAbsolute(appPath)
  ) {
    outputPaths.add(join(functionDir, appPath));
  }

  for (const parentDir of parentDirs) {
    const bundleRootPath = resolve(
      functionDir,
      relative(parentDir, sourcePath)
    );
    const relativeToFunction = relative(functionDir, bundleRootPath);
    if (
      relativeToFunction !== '' &&
      relativeToFunction !== '..' &&
      !relativeToFunction.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToFunction)
    ) {
      outputPaths.add(bundleRootPath);
    }
  }

  return [...outputPaths];
}

/**
 * The root directory of the package that owns a node_modules file
 * (handles scoped packages and pnpm store paths).
 */
function getOwningPackageDir(sourcePath: string): string | null {
  const normalized = sourcePath.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const segments = normalized.slice(markerIndex + marker.length).split('/');
  const packageSegments = segments[0]?.startsWith('@')
    ? segments.slice(0, 2)
    : segments.slice(0, 1);
  if (packageSegments.length === 0 || !packageSegments.at(-1)) return null;
  return (
    normalized.slice(0, markerIndex + marker.length) + packageSegments.join('/')
  );
}

/**
 * Native addons are loaded through runtime machinery that bundling can't
 * inline: sharp requires `@img/sharp-<platform>/sharp.node`, which
 * resolves through that package's `exports` map to a JS shim that loads
 * the real binary, which in turn dlopens shared libraries from sibling
 * packages declared as (optional) dependencies (`@img/sharp-libvips-*`,
 * linked via an ELF rpath). None of that is visible to JS analysis of the
 * bundle — so ship the addon's owning package wholesale, plus the
 * packages its package.json declares as dependencies.
 */
function getNativeAddonPackageDirs(addonPath: string): string[] {
  const packageDir = getOwningPackageDir(addonPath);
  if (!packageDir) return [];

  let packageJson: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  try {
    packageJson = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8')
    );
  } catch {
    return [packageDir];
  }

  const marker = '/node_modules/';
  const normalized = packageDir.replace(/\\/g, '/');
  const nodeModulesRoot = normalized.slice(
    0,
    normalized.lastIndexOf(marker) + marker.length
  );

  const names = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];
  return [
    packageDir,
    ...names
      .map((name) => join(nodeModulesRoot, name))
      .filter((dir) => existsSync(dir)),
  ];
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
   * assets they reference, which are copied into the function directory at
   * every location runtime lookups may probe (see
   * getRuntimeAssetOutputPaths). Files outside both the app directory and
   * node_modules — e.g. a monorepo pnpm store above the app — only get the
   * flattened node_modules location, which lookups with a baked
   * store-relative path (Prisma generated into a monorepo store) cannot
   * find; those setups need the package externalized instead of bundled.
   *
   * Known limitation: lookups relative to __dirname/import.meta.url inside
   * bundled code resolve against the function root (esbuild rewrites them),
   * not the copied node_modules path. Packages that also probe
   * process.cwd()-based locations — like Prisma's cwd-relative engine
   * probe — work; pure __dirname lookups from bundled dependencies are not
   * remapped.
   */
  private async copyTracedRuntimeAssets(
    functionDir: string,
    metafile: Metafile | undefined
  ): Promise<void> {
    if (!metafile) return;
    try {
      await this.traceAndCopyRuntimeAssets(functionDir, metafile);
    } catch (error) {
      // Best-effort: a tracing failure must not break builds that don't
      // depend on runtime assets. Degrade to the previous behavior
      // (nothing copied) with a warning.
      console.warn(
        `Failed to trace runtime assets for the workflow function: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async traceAndCopyRuntimeAssets(
    functionDir: string,
    metafile: Metafile
  ): Promise<void> {
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
    const visitedAddonDependencyDirs = new Set<string>();
    for (const file of fileList) {
      const reason = reasons.get(file);
      if (!reason || !isRuntimeAsset(file, reason.type)) continue;

      // nft returns paths relative to the trace base, but files it cannot
      // relativize (e.g. on another Windows drive) stay absolute.
      const toAbsolute = (traceFile: string) =>
        isAbsolute(traceFile) ? traceFile : join(traceBase, traceFile);
      const sourcePath = toAbsolute(file);
      // The directories of the modules that referenced this asset — their
      // __dirname is the function root once bundled.
      const parentDirs = [...reason.parents].map((parent) =>
        dirname(toAbsolute(parent))
      );
      await this.copyTracedRuntimeAsset(
        functionDir,
        sourcePath,
        parentDirs,
        copied
      );

      // Native addons load through runtime machinery bundling can't
      // inline (exports-mapped requires, JS shims, dlopen'd shared
      // libraries from dependency packages) — ship the owning package
      // and its declared dependency packages wholesale.
      if (sourcePath.endsWith('.node')) {
        for (const dependencyDir of getNativeAddonPackageDirs(sourcePath)) {
          if (visitedAddonDependencyDirs.has(dependencyDir)) continue;
          visitedAddonDependencyDirs.add(dependencyDir);
          const entries = await readdir(dependencyDir, {
            recursive: true,
            withFileTypes: true,
          }).catch(() => []);
          for (const entry of entries) {
            if (!entry.isFile()) continue;
            await this.copyTracedRuntimeAsset(
              functionDir,
              join(entry.parentPath, entry.name),
              [],
              copied
            );
          }
        }
      }
    }

    if (copied.size > 0) {
      this.logBaseBuilderInfo(
        `Copied ${copied.size} traced runtime ${pluralize('asset', 'assets', copied.size)} into the workflow function`
      );
    }
  }

  /**
   * Copies a runtime asset unless its output path is already claimed.
   * Two packages can flatten to the same output path (e.g. nested vs
   * hoisted copies of a package); the first one in trace order wins.
   */
  private async copyRuntimeAssetOnce(
    asset: { sourcePath: string; outputPath: string },
    copied: Map<string, string>,
    functionDir: string
  ): Promise<void> {
    const existingSource = copied.get(asset.outputPath);
    if (existingSource !== undefined) {
      if (existingSource !== asset.sourcePath) {
        console.warn(
          `Conflicting runtime assets for ${relative(functionDir, asset.outputPath)}: keeping ${existingSource}, skipping ${asset.sourcePath}`
        );
      }
      return;
    }
    await mkdir(dirname(asset.outputPath), { recursive: true });
    await copyFile(asset.sourcePath, asset.outputPath);
    copied.set(asset.outputPath, asset.sourcePath);
  }

  /**
   * Filters a traced file down to a copyable runtime asset and copies it
   * to every output location runtime lookups may probe.
   */
  private async copyTracedRuntimeAsset(
    functionDir: string,
    sourcePath: string,
    parentDirs: string[],
    copied: Map<string, string>
  ): Promise<void> {
    if (isSecretFile(sourcePath)) {
      this.logBaseBuilderInfo(
        `Skipping secret-like runtime asset: ${sourcePath}`
      );
      return;
    }
    // nft can emit directories and symlinks; only regular files are copied
    // (stat follows symlinks to the real contents).
    const stats = await stat(sourcePath).catch(() => null);
    if (!stats?.isFile()) return;

    const outputPaths = getRuntimeAssetOutputPaths(
      functionDir,
      sourcePath,
      this.config.workingDir,
      parentDirs
    );
    if (outputPaths.length === 0) {
      console.warn(
        `Runtime asset outside the app directory and node_modules is not copied into the workflow function: ${sourcePath}`
      );
      return;
    }

    for (const outputPath of outputPaths) {
      const outputFile = relative(functionDir, outputPath).replace(/\\/g, '/');
      if (GENERATED_FUNCTION_FILES.has(outputFile)) {
        console.warn(
          `Skipping runtime asset that conflicts with the generated function output: ${sourcePath}`
        );
        continue;
      }
      await this.copyRuntimeAssetOnce(
        { sourcePath, outputPath },
        copied,
        functionDir
      );
    }
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
