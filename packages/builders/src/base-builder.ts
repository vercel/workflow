import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildLogger } from '@workflow/core/logger';
import { WorkflowBuildError } from '@workflow/errors';
import { pluralize } from '@workflow/utils';
import chalk from 'chalk';
import enhancedResolveOriginal from 'enhanced-resolve';
import * as esbuild from 'esbuild';
import { findUp } from 'find-up';
import { glob } from 'tinyglobby';
import {
  applySwcTransform,
  type WorkflowManifest,
} from './apply-swc-transform.js';
import { createWorkflowEntrypointOptionsCode } from './constants.js';
import { getEsbuildTsconfigOptions } from './esbuild-tsconfig.js';
import {
  type DiscoveredEntries,
  fastDiscoverEntries,
} from './fast-discovery.js';
import {
  getImportPath,
  resolveModuleSpecifier,
  stripPackageVersion,
} from './module-specifier.js';
import { createNodeModuleErrorPlugin } from './node-module-esbuild-plugin.js';
import { createPseudoPackagePlugin } from './pseudo-package-esbuild-plugin.js';
import { createSwcPlugin } from './swc-esbuild-plugin.js';
import { detectWorkflowPatterns } from './transform-utils.js';
import type { SourcemapMode, WorkflowConfig } from './types.js';
import { extractWorkflowGraphs } from './workflows-extractor.js';
import {
  createWorkflowWorldTargetEsbuildPlugin,
  ensureWorkflowTargetWorldEnv,
} from './world-target.js';

const enhancedResolve = promisify(enhancedResolveOriginal);
const require = createRequire(import.meta.url);

export type { DiscoveredEntries } from './fast-discovery.js';

/**
 * Legacy opt-in for source maps on the final workflow wrapper + webhook
 * bundles (which default to off, unlike the step/interim workflow bundles
 * that default to inline). Superseded by the `sourcemap` config option and
 * the `WORKFLOW_SOURCEMAP` environment variable; kept for back-compat.
 */
const EMIT_SOURCEMAPS_FOR_DEBUGGING =
  process.env.WORKFLOW_EMIT_SOURCEMAPS_FOR_DEBUGGING === '1';

const VALID_SOURCEMAP_STRINGS = new Set([
  'inline',
  'linked',
  'external',
  'both',
]);

/**
 * Parse the value of the `WORKFLOW_SOURCEMAP` environment variable into a
 * `SourcemapMode`. Returns `undefined` if the env var is unset, empty, or
 * unrecognized (a warning is emitted for unrecognized values).
 */
function parseSourcemapEnv(
  value: string | undefined
): SourcemapMode | undefined {
  if (value === undefined || value === '') return undefined;
  switch (value) {
    case '0':
    case 'false':
      return false;
    case '1':
    case 'true':
      return true;
    default:
      if (VALID_SOURCEMAP_STRINGS.has(value)) {
        return value as SourcemapMode;
      }
      console.warn(
        `Ignoring unrecognized WORKFLOW_SOURCEMAP=${value}. ` +
          `Expected one of: true, false, 0, 1, inline, linked, external, both.`
      );
      return undefined;
  }
}

function formatBuildDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Normalize an array of file paths by appending the `realpath()` of each entry
 * (to handle symlinks, e.g. pnpm/workspace layouts) and deduplicating.
 */
async function withRealpaths(entries: string[]): Promise<string[]> {
  return Array.from(
    new Set(
      (
        await Promise.all(
          entries.map(async (entry) => {
            const resolved = await realpath(entry).catch(() => undefined);
            return resolved ? [entry, resolved] : [entry];
          })
        )
      ).flat()
    )
  );
}

/**
 * Canonical "what module does this file represent?" key used to dedupe
 * virtual-entry imports.
 *
 * If the file resolves to a real package specifier (`workflow/internal/builtins`,
 * `@internal/agent/server`, etc.), we return the bare specifier — version
 * stripped — because esbuild's package resolution will collapse all
 * importers of that specifier to the same physical module regardless of
 * which on-disk copy (src vs dist) any one importer wrote.
 *
 * Otherwise we fall back to the absolute file path. Distinct local-app
 * files have distinct paths, so this still dedupes a file against itself
 * (e.g. if it shows up in both `stepFiles` and `serdeOnlyFiles`) without
 * conflating unrelated files.
 */
function moduleIdentityKey(file: string, moduleSpecifierRoot: string): string {
  const { moduleSpecifier } = resolveModuleSpecifier(file, moduleSpecifierRoot);
  if (moduleSpecifier) {
    // Strip the "@<version>" suffix so source and dist copies of the same
    // export collapse to the same key.
    return stripPackageVersion(moduleSpecifier);
  }
  return file.replace(/\\/g, '/');
}

type ManifestEntryLocation = {
  filePath: string;
  name: string;
};

type CachedManifestTransform = {
  size: number;
  mtimeMs: number;
  manifest: WorkflowManifest;
};

function formatIdLocation(location: ManifestEntryLocation): string {
  return `${location.filePath}#${location.name}`;
}

function assertUniqueManifestIds<TEntry>(
  entriesByFile: Record<string, Record<string, TEntry>> | undefined,
  ids: Map<string, ManifestEntryLocation>,
  getId: (entry: TEntry) => string,
  label: 'step' | 'workflow'
): void {
  for (const [filePath, entries] of Object.entries(entriesByFile || {})) {
    for (const [name, data] of Object.entries(entries)) {
      const id = getId(data);
      const existing = ids.get(id);
      const current = { filePath, name };
      if (
        existing &&
        (existing.filePath !== current.filePath ||
          existing.name !== current.name)
      ) {
        const idName = label === 'step' ? 'workflow step ID' : 'workflow ID';
        const functionName = `${label} function`;
        const capitalizedLabel = label === 'step' ? 'Step' : 'Workflow';
        throw new WorkflowBuildError(
          `Duplicate ${idName} "${id}" generated for ${formatIdLocation(existing)} and ${formatIdLocation(current)}.`,
          {
            hint:
              `${capitalizedLabel} IDs must be unique across a build. ` +
              `If you own one of the colliding files, rename the ${functionName} or export ` +
              `the package file through a unique package subpath. If the collision is in a ` +
              `transitive dependency you don't control, file an issue with the upstream ` +
              `package or pin to a non-colliding version.`,
          }
        );
      }
      ids.set(id, current);
    }
  }
}

function mergeWorkflowManifest(
  target: WorkflowManifest,
  incoming: WorkflowManifest,
  stepIds: Map<string, ManifestEntryLocation>,
  workflowIds: Map<string, ManifestEntryLocation>
): void {
  assertUniqueManifestIds(
    incoming.steps,
    stepIds,
    (data) => data.stepId,
    'step'
  );
  assertUniqueManifestIds(
    incoming.workflows,
    workflowIds,
    (data) => data.workflowId,
    'workflow'
  );

  target.workflows = Object.assign(target.workflows || {}, incoming.workflows);
  target.steps = Object.assign(target.steps || {}, incoming.steps);
  target.classes = Object.assign(target.classes || {}, incoming.classes);
}

/**
 * Base class for workflow builders. Provides common build logic for transforming
 * workflow source files into deployable bundles using esbuild and SWC.
 *
 * Subclasses must implement the build() method to define builder-specific logic.
 */
export abstract class BaseBuilder {
  protected config: WorkflowConfig;

  /**
   * Tracks which external packages have already been warned about
   * to avoid duplicate warnings across multiple discoverEntries() calls.
   */
  private warnedExternalPackages = new Set<string>();
  private workflowBuildStartTime: number | undefined;
  private manifestTransformCache = new Map<string, CachedManifestTransform>();

  constructor(config: WorkflowConfig) {
    ensureWorkflowTargetWorldEnv();
    this.config = config;
  }

  protected get transformProjectRoot(): string {
    return this.config.projectRoot || this.config.workingDir;
  }

  protected get moduleSpecifierRoot(): string {
    return this.config.moduleSpecifierRoot || this.transformProjectRoot;
  }

  private createWorkflowWorldTargetPlugin(): esbuild.Plugin {
    return createWorkflowWorldTargetEsbuildPlugin({
      workingDir: this.config.workingDir,
      externalPackages: this.config.externalPackages,
    });
  }

  protected logBaseBuilderInfo(...args: unknown[]): void {
    buildLogger.debug(args.map(String).join(' '));
  }

  private startWorkflowBuildTimer(): void {
    this.workflowBuildStartTime = Date.now();
  }

  private getWorkflowBuildDuration(): number {
    return Date.now() - (this.workflowBuildStartTime ?? Date.now());
  }

  private resetWorkflowBuildTimer(): void {
    this.workflowBuildStartTime = undefined;
  }

  private getWorkflowBuildSummary({
    stepCount,
    workflowCount,
  }: {
    stepCount: number;
    workflowCount: number;
  }): string {
    const counts = `${stepCount} ${pluralize('step', 'steps', stepCount)}, ${workflowCount} ${pluralize('workflow', 'workflows', workflowCount)}`;
    return `✓ Compiled workflows in ${formatBuildDuration(this.getWorkflowBuildDuration())} (${counts})`;
  }

  private logCreateWorkflowsBundleInfo(...args: unknown[]): void {
    if (!this.config.suppressCreateWorkflowsBundleLogs) {
      this.logBaseBuilderInfo(...args);
    }
  }

  private logCreateWebhookBundleInfo(...args: unknown[]): void {
    if (!this.config.suppressCreateWebhookBundleLogs) {
      this.logBaseBuilderInfo(...args);
    }
  }

  private logCreateManifestInfo(...args: unknown[]): void {
    if (!this.config.suppressCreateManifestLogs) {
      this.logBaseBuilderInfo(...args);
    }
  }

  private async filterExistingFilesForWatch(
    files: string[],
    label: string
  ): Promise<string[]> {
    if (!this.config.watch || files.length === 0) {
      return files;
    }

    let missingCount = 0;
    const existingFiles = (
      await Promise.all(
        files.map(async (file) => {
          try {
            await stat(file);
            return file;
          } catch (error) {
            const code =
              error && typeof error === 'object' && 'code' in error
                ? (error as NodeJS.ErrnoException).code
                : undefined;
            if (code === 'ENOENT') {
              missingCount++;
              return undefined;
            }
            throw error;
          }
        })
      )
    ).filter((file): file is string => Boolean(file));

    if (missingCount === 0) {
      return files;
    }

    this.logBaseBuilderInfo(
      `Skipped ${missingCount} missing ${label} during watch rebuild`
    );
    return existingFiles;
  }

  /**
   * When outputting CJS, esbuild replaces `import.meta` with an empty object,
   * making `import.meta.url` (and `import.meta.resolve`) undefined. This method
   * returns banner code and `define` entries that polyfill them using CJS
   * equivalents (`__filename`, `require.resolve`) so user code (e.g. Prisma)
   * that relies on `import.meta.url` works correctly in bundled CJS output.
   */
  private getCjsImportMetaPolyfill(format: string): {
    banner: string;
    define: Record<string, string>;
  } {
    if (format !== 'cjs') return { banner: '', define: {} };
    return {
      banner:
        'var __import_meta_url = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : undefined;\n' +
        'var __import_meta_resolve = typeof require !== "undefined" && typeof __filename !== "undefined" ' +
        '? (s) => require("url").pathToFileURL(require.resolve(s)).href : undefined;\n',
      define: {
        'import.meta.url': '__import_meta_url',
        'import.meta.resolve': '__import_meta_resolve',
      },
    };
  }

  /**
   * When outputting fully-bundled ESM, CJS dependencies that call require()
   * for Node.js builtins (e.g. debug → require('tty')) break because esbuild's
   * CJS-to-ESM __require shim doesn't have access to a real require function.
   * This banner provides one via createRequire so bundled CJS code works in ESM.
   */
  private getEsmRequireBanner(format: string): string {
    if (format !== 'esm') return '';
    return 'import { createRequire as __createRequire } from "node:module";\nvar require = __createRequire(import.meta.url);\n';
  }

  /**
   * Performs the complete build process for workflows.
   * Subclasses must implement this to define their specific build steps.
   */
  abstract build(): Promise<void>;

  /**
   * Finds tsconfig.json/jsconfig.json for the project.
   * Used by esbuild to properly resolve module imports during bundling.
   */
  protected async findTsConfigPath(): Promise<string | undefined> {
    const cwd = this.config.workingDir || process.cwd();
    return findUp(['tsconfig.json', 'jsconfig.json'], { cwd });
  }

  /**
   * Discovers all source files in the configured directories.
   * Searches for TypeScript and JavaScript files while excluding common build
   * and dependency directories.
   */
  protected async getInputFiles(): Promise<string[]> {
    const ignore = [
      '**/node_modules/**',
      '**/.git/**',
      '**/.next/**',
      '**/.nitro/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/.vercel/**',
      '**/.workflow-data/**',
      '**/.workflow-vitest/**',
      '**/.well-known/workflow/**',
      '**/.swc/**',
      '**/.svelte-kit/**',
      '**/.turbo/**',
      '**/.cache/**',
      '**/.yarn/**',
      '**/.pnpm-store/**',
    ];

    // Use relative patterns with `cwd` per directory so that `dot: true`
    // applies consistently to both the search pattern *and* the ignore
    // patterns. When absolute patterns are used with tinyglobby, the `**`
    // in ignore patterns does not match dot-prefixed path segments.
    const results = await Promise.all(
      this.config.dirs.map((dir) => {
        const cwd = resolve(this.config.workingDir, dir);
        return glob(['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'], {
          cwd,
          ignore,
          absolute: true,
          dot: true,
        });
      })
    );

    return results.flat();
  }

  /**
   * Caches discovered workflow entries by input array reference.
   * Uses WeakMap to allow garbage collection when input arrays are no longer referenced.
   * This cache is invalidated automatically when the inputs array reference changes
   * (e.g., when files are added/removed during watch mode).
   */
  private discoveredEntries: WeakMap<string[], DiscoveredEntries> =
    new WeakMap();

  public clearDiscoveredEntriesCache(): void {
    this.discoveredEntries = new WeakMap();
  }

  public clearManifestTransformCache(): void {
    this.manifestTransformCache.clear();
  }

  /**
   * Pseudo-packages that should not be checked for workflow patterns.
   */
  private static readonly PSEUDO_PACKAGES = new Set([
    'server-only',
    'client-only',
  ]);

  /**
   * Checks each package in externalPackages for workflow patterns and emits
   * warnings if any contain "use step", "use workflow" directives, or
   * serialization classes. These patterns will not be transformed by the
   * workflow compiler when the package is externalized.
   */
  private async warnAboutExternalWorkflowPackages(): Promise<void> {
    const externalPackages = this.config.externalPackages;
    if (!externalPackages?.length) return;

    for (const pkg of externalPackages) {
      if (BaseBuilder.PSEUDO_PACKAGES.has(pkg)) continue;
      if (this.warnedExternalPackages.has(pkg)) continue;

      if (
        pkg.startsWith('.') ||
        pkg.startsWith('/') ||
        pkg.startsWith('$') ||
        pkg.includes('*') ||
        pkg.includes(':')
      ) {
        continue;
      }

      try {
        // Check package.json dependencies for @workflow/serde (fast path)
        let hasWorkflowSerdeDep = false;
        try {
          const pkgJsonPath = require.resolve(`${pkg}/package.json`, {
            paths: [this.config.workingDir],
          });
          const pkgJsonSource = await readFile(pkgJsonPath, 'utf-8');
          const pkgJson = JSON.parse(pkgJsonSource) as {
            dependencies?: unknown;
            peerDependencies?: unknown;
          };
          const dependencies =
            typeof pkgJson.dependencies === 'object' &&
            pkgJson.dependencies !== null &&
            !Array.isArray(pkgJson.dependencies)
              ? (pkgJson.dependencies as Record<string, unknown>)
              : {};
          const peerDependencies =
            typeof pkgJson.peerDependencies === 'object' &&
            pkgJson.peerDependencies !== null &&
            !Array.isArray(pkgJson.peerDependencies)
              ? (pkgJson.peerDependencies as Record<string, unknown>)
              : {};
          hasWorkflowSerdeDep =
            Object.hasOwn(dependencies, '@workflow/serde') ||
            Object.hasOwn(peerDependencies, '@workflow/serde');
        } catch {
          // package.json not resolvable - continue to source check
        }

        // Check source patterns (thorough path).
        // Note: require.resolve only inspects the package's main entry point.
        // If workflow constructs live in sub-paths (e.g. `my-pkg/workflows`),
        // they won't be detected here. The @workflow/serde dep check above
        // partially covers serde cases. This is acceptable as a best-effort
        // heuristic — the primary fix is auto-removal in withWorkflow().
        let hasUseStep = false;
        let hasUseWorkflow = false;
        let hasSerde = hasWorkflowSerdeDep;
        try {
          const entryPath = require.resolve(pkg, {
            paths: [this.config.workingDir],
          });
          const source = await readFile(entryPath, 'utf-8');
          const patterns = detectWorkflowPatterns(source);
          hasUseStep = patterns.hasUseStep;
          hasUseWorkflow = patterns.hasUseWorkflow;
          if (!hasSerde) {
            hasSerde = patterns.hasSerde;
          }
        } catch {
          // Entry file not resolvable or not readable - use what we have
        }

        if (!hasUseStep && !hasUseWorkflow && !hasSerde) continue;

        // Build a specific description of what was found
        const issues: string[] = [];
        if (hasUseWorkflow) issues.push('"use workflow" functions');
        if (hasUseStep) issues.push('"use step" functions');
        if (hasSerde) issues.push('serialization classes');

        this.warnedExternalPackages.add(pkg);

        console.warn(
          `\n${chalk.yellow('⚠')} Warning: ${chalk.bold(`"${pkg}"`)} is listed in ${chalk.bold('externalPackages')} (${chalk.bold('serverExternalPackages')} in Next.js) but contains workflow code (${issues.join(', ')}).` +
            `\n  This code will ${chalk.bold('not')} be transformed by the workflow compiler, which can cause runtime failures.` +
            `\n  Remove ${chalk.bold(`"${pkg}"`)} from ${chalk.bold('externalPackages')} (${chalk.bold('serverExternalPackages')} in Next.js) to fix this.\n`
        );
      } catch {
        // Best-effort: if anything goes wrong, skip this package silently
      }
    }
  }

  protected async discoverEntries(
    inputs: string[],
    outdir: string,
    tsconfigPath?: string
  ): Promise<DiscoveredEntries> {
    const effectiveInputs = await this.filterExistingFilesForWatch(
      inputs,
      'input files'
    );
    const previousResult = this.discoveredEntries.get(effectiveInputs);

    if (previousResult) {
      return previousResult;
    }
    const state: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set(),
      discoveredSerdeFiles: new Set(),
      discoveredFiles: new Set(),
    };

    const discoverStart = Date.now();

    // Resolve the SDK runtime serde entry point so that the discovery pass
    // discovers classes like `Run` that live inside SDK packages. Without this,
    // files like `run.js` are only discovered when user code imports them.
    // This is resolved here (rather than in callers) so that the original
    // `inputs` array reference is preserved for WeakMap caching — callers
    // like createWorkflowsBundle and createStepsBundle can share the same
    // cache entry when they pass the same inputFiles array.
    const resolvedWorkflowRuntime = await enhancedResolve(
      outdir,
      '@workflow/core/runtime/run'
    ).catch(() => undefined);
    const entryPoints = resolvedWorkflowRuntime
      ? [...effectiveInputs, resolvedWorkflowRuntime]
      : effectiveInputs;

    const effectiveTsconfigPath =
      tsconfigPath ?? (await this.findTsConfigPath());

    await fastDiscoverEntries({
      entryPoints,
      state,
      defaultTsconfigPath: effectiveTsconfigPath,
      workingDir: this.config.workingDir,
    });

    this.logBaseBuilderInfo(
      `Discovering workflow directives`,
      `${Date.now() - discoverStart}ms`
    );

    // Warn about external packages that contain workflow code
    await this.warnAboutExternalWorkflowPackages();

    this.discoveredEntries.set(effectiveInputs, state);
    return state;
  }

  /**
   * Writes generated files atomically where possible. On Windows, Next.js can
   * briefly hold generated route files open while compiling them, which makes
   * rename-over-existing fail with EPERM/EACCES. In that case, fall back to a
   * direct overwrite so watch rebuilds can still make progress.
   */
  private async writeGeneratedFile(
    targetPath: string,
    content: string
  ): Promise<void> {
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, content);
    try {
      await rename(tempPath, targetPath);
    } catch (error) {
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (
        process.platform === 'win32' &&
        (errorCode === 'EPERM' || errorCode === 'EACCES')
      ) {
        await writeFile(targetPath, content);
        await rm(tempPath, { force: true });
        return;
      }
      throw error;
    }
  }

  /**
   * Writes debug information to a JSON file for troubleshooting build issues.
   * Uses atomic write (temp file + rename) to prevent race conditions when
   * multiple builds run concurrently.
   */
  private async writeDebugFile(
    outfile: string,
    debugData: object,
    merge?: boolean
  ): Promise<void> {
    const prefix = this.config.debugFilePrefix || '';
    const targetPath = `${dirname(outfile)}/${prefix}${basename(outfile)}.debug.json`;
    let existing = {};

    try {
      if (merge) {
        try {
          const content = await readFile(targetPath, 'utf8');
          existing = JSON.parse(content);
        } catch (e) {
          // File doesn't exist yet or is corrupted - start fresh.
          // Don't log error for ENOENT (file not found) as that's expected on first run.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('Error reading debug file, starting fresh:', e);
          }
        }
      }

      const mergedData = JSON.stringify(
        {
          ...existing,
          ...debugData,
        },
        null,
        2
      );

      await this.writeGeneratedFile(targetPath, mergedData);
    } catch (error: unknown) {
      console.warn('Failed to write debug file:', error);
    }
  }

  /**
   * Logs and optionally throws on esbuild errors and warnings.
   * @param throwOnError - If true, throws an error when esbuild errors are present
   */
  private logEsbuildMessages(
    result: { errors?: any[]; warnings?: any[] },
    phase: string,
    throwOnError = true,
    options?: {
      suppressWarnings?: boolean;
    }
  ): void {
    if (result.errors && result.errors.length > 0) {
      console.error(`❌ esbuild errors in ${phase}:`);
      const errorMessages: string[] = [];
      for (const error of result.errors) {
        console.error(`  ${error.text}`);
        errorMessages.push(error.text);
        if (error.location) {
          const location = `    at ${error.location.file}:${error.location.line}:${error.location.column}`;
          console.error(location);
          errorMessages.push(location);
        }
      }

      if (throwOnError) {
        throw new WorkflowBuildError(
          `Build failed during ${phase}:\n${errorMessages.join('\n')}`,
          {
            hint: `Review the esbuild errors above — they come from the ${phase} bundle. Fix the offending source files and re-run the build.`,
          }
        );
      }
    }

    if (
      !options?.suppressWarnings &&
      result.warnings &&
      result.warnings.length > 0
    ) {
      console.warn(`!  esbuild warnings in ${phase}:`);
      for (const warning of result.warnings) {
        console.warn(`  ${warning.text}`);
        if (warning.location) {
          console.warn(
            `    at ${warning.location.file}:${warning.location.line}:${warning.location.column}`
          );
        }
      }
    }
  }

  /**
   * Converts an absolute file path to a normalized relative path for the manifest.
   */
  private getRelativeFilepath(absolutePath: string): string {
    const normalizedFile = absolutePath.replace(/\\/g, '/');
    const normalizedWorkingDir = this.config.workingDir.replace(/\\/g, '/');
    let relativePath = relative(normalizedWorkingDir, normalizedFile).replace(
      /\\/g,
      '/'
    );
    // Handle files discovered outside the working directory
    if (relativePath.startsWith('../')) {
      relativePath = relativePath
        .split('/')
        .filter((part) => part !== '..')
        .join('/');
    }
    return relativePath;
  }

  private async getCachedManifestTransform(
    file: string,
    mode: 'workflow' | 'step'
  ): Promise<WorkflowManifest> {
    const stats = await stat(file);
    const cacheKey = `${mode}:${file}`;
    const cached = this.manifestTransformCache.get(cacheKey);
    if (
      cached &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs
    ) {
      return cached.manifest;
    }

    const source = await readFile(file, 'utf8');
    const relativeFilepath = this.getRelativeFilepath(file);
    const { workflowManifest } = await applySwcTransform(
      relativeFilepath,
      source,
      mode,
      file,
      this.transformProjectRoot,
      this.moduleSpecifierRoot
    );
    this.manifestTransformCache.set(cacheKey, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      manifest: workflowManifest,
    });
    return workflowManifest;
  }

  protected createRouteImportSpecifier(file: string, routeDir: string): string {
    const { importPath, isPackage } = getImportPath(
      file,
      this.config.workingDir
    );
    if (isPackage) {
      return importPath;
    }

    let relativePath = relative(routeDir, file).replace(/\\/g, '/');
    if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
      relativePath = `./${relativePath}`;
    }
    return relativePath;
  }

  protected async createStepSourceRegistrationFile({
    inputFiles,
    outfile,
    tsconfigPath,
    discoveredEntries,
  }: {
    inputFiles: string[];
    outfile: string;
    tsconfigPath?: string;
    discoveredEntries?: DiscoveredEntries;
  }): Promise<WorkflowManifest> {
    const stepsBundleStart = Date.now();
    const workflowManifest: WorkflowManifest = {};
    const builtInSteps = 'workflow/internal/builtins';
    const resolvedBuiltInSteps = (await enhancedResolve(
      dirname(outfile),
      builtInSteps
    ).catch((err) => {
      throw new WorkflowBuildError(
        `Failed to resolve built-in steps sources.\n\nCaused by: ${String(err)}`,
        {
          hint: 'run `pnpm install workflow` to resolve this issue.',
          cause: err,
        }
      );
    })) as string;

    const discovered =
      discoveredEntries ??
      (await this.discoverEntries(inputFiles, dirname(outfile), tsconfigPath));
    const stepFiles = await this.filterExistingFilesForWatch(
      [...discovered.discoveredSteps].sort(),
      'step files'
    );
    const workflowFiles = await this.filterExistingFilesForWatch(
      [...discovered.discoveredWorkflows].sort(),
      'workflow files'
    );
    const serdeFiles = await this.filterExistingFilesForWatch(
      [...discovered.discoveredSerdeFiles].sort(),
      'serde files'
    );
    const stepFilesSet = new Set(stepFiles);
    const serdeOnlyFiles = serdeFiles.filter((f) => !stepFilesSet.has(f));

    await this.writeDebugFile(outfile, {
      stepFiles,
      workflowFiles,
      serdeOnlyFiles,
      sourceImports: true,
    });

    const emittedImportIdentities = new Set<string>([builtInSteps]);
    const importStatements: string[] = [];
    const routeDir = dirname(outfile);
    const addRegistrationImport = (specifier: string): void => {
      importStatements.push(`import ${JSON.stringify(specifier)};`);
    };
    const addRegistrationFileImport = (file: string): void => {
      const identity = moduleIdentityKey(file, this.moduleSpecifierRoot);
      if (emittedImportIdentities.has(identity)) {
        return;
      }
      emittedImportIdentities.add(identity);
      addRegistrationImport(this.createRouteImportSpecifier(file, routeDir));
    };

    addRegistrationImport(builtInSteps);
    for (const file of stepFiles) {
      addRegistrationFileImport(file);
    }
    for (const file of serdeOnlyFiles) {
      addRegistrationFileImport(file);
    }

    const output = `// biome-ignore-all lint: generated file
/* eslint-disable */
${importStatements.join('\n')}

export const __steps_registered = true;
`;
    await mkdir(dirname(outfile), { recursive: true });
    const tempPath = `${outfile}.${randomUUID()}.tmp`;
    await writeFile(tempPath, output);
    await rename(tempPath, outfile);

    const manifestFiles = Array.from(
      new Set([...stepFiles, ...serdeOnlyFiles, resolvedBuiltInSteps])
    ).sort();
    const stepIds = new Map<string, ManifestEntryLocation>();
    const workflowIds = new Map<string, ManifestEntryLocation>();
    await Promise.all(
      manifestFiles.map(async (file) => {
        const fileManifest = await this.getCachedManifestTransform(
          file,
          'step'
        );
        mergeWorkflowManifest(
          workflowManifest,
          fileManifest,
          stepIds,
          workflowIds
        );
      })
    );

    await this.ensureSwcIgnored();
    this.logBaseBuilderInfo(
      'Created step registrations',
      `${Date.now() - stepsBundleStart}ms`
    );
    return workflowManifest;
  }

  /**
   * Creates a bundle for workflow step functions.
   * Steps have full Node.js runtime access and handle side effects, API calls, etc.
   *
   * @param externalizeNonSteps - If true, only bundles step entry points and externalizes other code
   * @param sourceStepRegistrationImports - If true, emits a source import registration file instead of bundling step registrations
   * @param bundleTransitiveLocalStepDependencies - If true, also bundles project-local files imported by step entries for direct runtime loading
   * @returns Build context (for watch mode) and the collected workflow manifest
   */
  protected async createStepsBundle({
    inputFiles,
    format = 'esm',
    outfile,
    externalizeNonSteps,
    bundleTransitiveLocalStepDependencies,
    sourceStepRegistrationImports,
    rewriteTsExtensions,
    tsconfigPath,
    discoveredEntries,
    skipEsmRequireBanner = false,
  }: {
    tsconfigPath?: string;
    inputFiles: string[];
    outfile: string;
    format?: 'cjs' | 'esm';
    externalizeNonSteps?: boolean;
    bundleTransitiveLocalStepDependencies?: boolean;
    sourceStepRegistrationImports?: boolean;
    rewriteTsExtensions?: boolean;
    discoveredEntries?: DiscoveredEntries;
    /**
     * When true, skip the `createRequire` banner on the steps bundle.
     * Used by `createCombinedBundle` with `bundleFinalOutput: true` where
     * the outer esbuild pass provides its own banner, preventing the
     * `__createRequire` identifier from being declared twice after inlining.
     */
    skipEsmRequireBanner?: boolean;
  }): Promise<{
    context: esbuild.BuildContext | undefined;
    manifest: WorkflowManifest;
  }> {
    const stepsBundleStart = Date.now();
    const workflowManifest: WorkflowManifest = {};
    const builtInSteps = 'workflow/internal/builtins';

    const resolvedBuiltInSteps = await enhancedResolve(
      dirname(outfile),
      'workflow/internal/builtins'
    ).catch((err) => {
      throw new WorkflowBuildError(
        `Failed to resolve built-in steps sources.\n\nCaused by: ${String(err)}`,
        {
          hint: 'run `pnpm install workflow` to resolve this issue.',
          cause: err,
        }
      );
    });

    // Discovery of workflow/step/serde entries. The SDK runtime entry point
    // (workflow/runtime) is resolved inside discoverEntries() itself so that
    // callers can pass the original inputFiles reference and benefit from
    // WeakMap caching across createWorkflowsBundle / createStepsBundle calls.
    const discovered =
      discoveredEntries ??
      (await this.discoverEntries(inputFiles, dirname(outfile), tsconfigPath));
    const stepFiles = await this.filterExistingFilesForWatch(
      [...discovered.discoveredSteps].sort(),
      'step files'
    );
    const workflowFiles = await this.filterExistingFilesForWatch(
      [...discovered.discoveredWorkflows].sort(),
      'workflow files'
    );
    const serdeFiles = await this.filterExistingFilesForWatch(
      [...discovered.discoveredSerdeFiles].sort(),
      'serde files'
    );

    // Include serde files that aren't already step files for cross-context class registration.
    // Classes need to be registered in the step bundle so they can be deserialized
    // when receiving data from workflows and serialized when returning data to workflows.
    const stepFilesSet = new Set(stepFiles);
    const serdeOnlyFiles = serdeFiles.filter((f) => !stepFilesSet.has(f));

    if (
      sourceStepRegistrationImports &&
      externalizeNonSteps &&
      !bundleTransitiveLocalStepDependencies
    ) {
      return {
        context: undefined,
        manifest: await this.createStepSourceRegistrationFile({
          inputFiles,
          outfile,
          tsconfigPath,
          discoveredEntries: discovered,
        }),
      };
    }

    // log the step files for debugging
    await this.writeDebugFile(outfile, {
      stepFiles,
      workflowFiles,
      serdeOnlyFiles,
    });

    // Helper to create import statement from file path
    // For workspace/node_modules packages, uses the package name so esbuild
    // will resolve through package.json exports with the appropriate conditions
    const createImport = (file: string) => {
      const normalizedWorkspaceRoot = this.config.workingDir
        .replace(/\\/g, '/')
        .replace(/\/$/, '');
      const normalizedWorkspaceFile = file.replace(/\\/g, '/');
      // Only use relative source paths for workspace symlinks (files
      // outside node_modules in a packages/*/src/ directory). For tarball-
      // installed packages (files inside node_modules/), fall through to
      // getImportPath which returns package specifiers — this allows the
      // SWC plugin's externalizeNonSteps to work correctly.
      const isWorkspaceSourceBackedPackageFile =
        normalizedWorkspaceFile.includes('/packages/') &&
        normalizedWorkspaceFile.includes('/src/') &&
        !normalizedWorkspaceFile.includes('/node_modules/') &&
        !(
          normalizedWorkspaceFile === normalizedWorkspaceRoot ||
          normalizedWorkspaceFile.startsWith(`${normalizedWorkspaceRoot}/`)
        );
      const isSourceBackedPackageFile = isWorkspaceSourceBackedPackageFile;

      if (isSourceBackedPackageFile) {
        let relativePath = relative(
          normalizedWorkspaceRoot,
          normalizedWorkspaceFile
        ).replace(/\\/g, '/');
        if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
          relativePath = `./${relativePath}`;
        }
        return `import '${relativePath}';`;
      }

      const { importPath, isPackage } = getImportPath(
        file,
        this.config.workingDir
      );

      if (isPackage) {
        // Use package name - esbuild will resolve via package.json exports
        return `import '${importPath}';`;
      }

      // Local app file - use relative path
      // Normalize both paths to forward slashes before calling relative()
      // This is critical on Windows where relative() can produce unexpected results with mixed path formats
      const normalizedWorkingDir = this.config.workingDir.replace(/\\/g, '/');
      const normalizedFile = file.replace(/\\/g, '/');
      // Calculate relative path from working directory to the file
      let relativePath = relative(normalizedWorkingDir, normalizedFile).replace(
        /\\/g,
        '/'
      );
      // Ensure relative paths start with ./ so esbuild resolves them correctly.
      // Paths like ".output/..." are not valid relative specifiers and must
      // become "./.output/...".
      if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
        relativePath = `./${relativePath}`;
      }
      return `import '${relativePath}';`;
    };

    // Create a virtual entry that imports all files. All step definitions
    // will get registered thanks to the swc transform.
    //
    // Dedupe imports by canonical module identity so we never emit two
    // import lines that resolve to the same physical module. Pre-seed the
    // set with the built-in steps import so a workspace step file at
    // `packages/workflow/src/internal/builtins.ts` doesn't emit a second,
    // relative-path competing import — esbuild would otherwise transform
    // both copies and the swc plugin would generate duplicate step IDs.
    const emittedImportIdentities = new Set<string>([builtInSteps]);
    const buildImports = (files: string[]): string =>
      files
        .filter((file) => {
          const identity = moduleIdentityKey(file, this.moduleSpecifierRoot);
          if (emittedImportIdentities.has(identity)) return false;
          emittedImportIdentities.add(identity);
          return true;
        })
        .map(createImport)
        .join('\n');

    const stepImports = buildImports(stepFiles);

    // Include serde-only files for class registration side effects
    const serdeImports = buildImports(serdeOnlyFiles);

    const entryContent = `
    // Built in steps
    import '${builtInSteps}';
    // User steps
    ${stepImports}
    // Serde files for cross-context class registration
    ${serdeImports}
    // Sentinel export so bundlers (rollup) don't tree-shake this module
    // when it's imported as a side-effect-only dependency.
    export const __steps_registered = true;`;

    // Bundle with esbuild and our custom SWC plugin
    const entriesToBundle = externalizeNonSteps
      ? [
          ...stepFiles,
          ...serdeFiles,
          ...(resolvedBuiltInSteps ? [resolvedBuiltInSteps] : []),
        ]
      : undefined;
    const normalizedEntriesToBundle = entriesToBundle
      ? await withRealpaths(entriesToBundle)
      : undefined;
    const normalizedSideEffectEntries = await withRealpaths([
      ...stepFiles,
      ...serdeOnlyFiles,
      ...(resolvedBuiltInSteps ? [resolvedBuiltInSteps] : []),
    ]);
    const esbuildTsconfigOptions =
      await getEsbuildTsconfigOptions(tsconfigPath);
    const { banner: importMetaBanner, define: importMetaDefine } =
      this.getCjsImportMetaPolyfill(format);
    const esmRequireBanner = skipEsmRequireBanner
      ? ''
      : this.getEsmRequireBanner(format);

    const esbuildCtx = await esbuild.context({
      banner: {
        js: `// biome-ignore-all lint: generated file\n/* eslint-disable */\n${importMetaBanner}${esmRequireBanner}`,
      },
      stdin: {
        contents: entryContent,
        resolveDir: this.config.workingDir,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      outfile,
      absWorkingDir: this.config.workingDir,
      bundle: true,
      format,
      platform: 'node',
      conditions: ['node'],
      target: 'es2022',
      write: true,
      treeShaking: true,
      keepNames: true,
      minify: false,
      jsx: 'preserve',
      logLevel: 'error',
      // Use tsconfig for path alias resolution.
      // For symlinked configs this uses tsconfigRaw to preserve cwd-relative aliases.
      ...esbuildTsconfigOptions,
      define: importMetaDefine,
      resolveExtensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
      ],
      // Source maps for better stack traces in step execution. Steps execute
      // in Node.js context and inline sourcemaps give meaningful stack traces
      // with proper file names and line numbers when errors occur in deeply
      // nested function calls across multiple files. Defaults to inline in
      // development and off in production (see `defaultSourcemapMode`) to keep
      // production function bundles small; override with the `sourcemap`
      // config option or the `WORKFLOW_SOURCEMAP` env var.
      sourcemap: this.resolveSourcemap(this.defaultSourcemapMode),
      plugins: [
        // Handle pseudo-packages like 'server-only' and 'client-only' by providing
        // empty modules. Must run first to intercept these before other resolution.
        createPseudoPackagePlugin(),
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: normalizedEntriesToBundle,
          outdir: outfile ? dirname(outfile) : undefined,
          projectRoot: this.transformProjectRoot,
          moduleSpecifierRoot: this.moduleSpecifierRoot,
          workflowManifest,
          bundleTransitiveLocalStepDependencies,
          rewriteTsExtensions,
          sideEffectEntries: normalizedSideEffectEntries,
        }),
      ],
      // Plugin should catch most things, but this lets users hard override
      // if the plugin misses anything that should be externalized
      external: ['bun', 'bun:*', ...(this.config.externalPackages || [])],
    });

    const stepsResult = await esbuildCtx.rebuild();

    this.logEsbuildMessages(stepsResult, 'steps bundle creation');
    this.logBaseBuilderInfo(
      'Created steps bundle',
      `${Date.now() - stepsBundleStart}ms`
    );

    // Handle workflow-only files that may have been tree-shaken from the bundle.
    // These files have no steps, so esbuild removes them, but we still need their
    // workflow metadata for the manifest. Transform them separately.
    const workflowOnlyFiles = workflowFiles.filter(
      (f) => !stepFiles.includes(f)
    );
    await Promise.all(
      workflowOnlyFiles.map(async (workflowFile) => {
        try {
          const fileManifest = await this.getCachedManifestTransform(
            workflowFile,
            'workflow'
          );
          if (fileManifest.workflows) {
            workflowManifest.workflows = Object.assign(
              workflowManifest.workflows || {},
              fileManifest.workflows
            );
          }
          if (fileManifest.classes) {
            workflowManifest.classes = Object.assign(
              workflowManifest.classes || {},
              fileManifest.classes
            );
          }
        } catch (error) {
          // Log warning but continue - don't fail build for workflow-only file issues
          console.warn(
            `Warning: Failed to extract workflow metadata from ${workflowFile}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      })
    );

    await this.ensureSwcIgnored();

    if (this.config.watch) {
      return { context: esbuildCtx, manifest: workflowManifest };
    }
    await esbuildCtx.dispose();
    return { context: undefined, manifest: workflowManifest };
  }

  /**
   * Creates a bundle for workflow orchestration functions.
   * Workflows run in a sandboxed VM and coordinate step execution.
   *
   * @param bundleFinalOutput - If false, skips the final bundling step (used by Next.js)
   */
  protected async createWorkflowsBundle({
    inputFiles,
    format = 'esm',
    outfile,
    bundleFinalOutput = true,
    keepInterimBundleContext = this.config.watch,
    tsconfigPath,
    discoveredEntries,
  }: {
    tsconfigPath?: string;
    inputFiles: string[];
    outfile: string;
    format?: 'cjs' | 'esm';
    bundleFinalOutput?: boolean;
    keepInterimBundleContext?: boolean;
    discoveredEntries?: DiscoveredEntries;
  }): Promise<{
    manifest: WorkflowManifest;
    interimBundleCtx?: esbuild.BuildContext;
    bundleFinal?: (interimBundleResult: string) => Promise<void>;
    /** The raw workflow VM code (before wrapping with entrypoint) */
    interimBundleText?: string;
  }> {
    const discovered =
      discoveredEntries ??
      (await this.discoverEntries(inputFiles, dirname(outfile), tsconfigPath));
    const workflowFiles = await this.filterExistingFilesForWatch(
      [...discovered.discoveredWorkflows].sort(),
      'workflow files'
    );
    const serdeFiles = await this.filterExistingFilesForWatch(
      [...discovered.discoveredSerdeFiles].sort(),
      'serde files'
    );

    // Include serde files that aren't already workflow files for cross-context class registration.
    // Classes need to be registered in the workflow bundle so they can be deserialized
    // when receiving data from steps or when serializing data to send to steps.
    const workflowFilesSet = new Set(workflowFiles);
    const serdeOnlyFiles = serdeFiles.filter((f) => !workflowFilesSet.has(f));

    // log the workflow files for debugging
    await this.writeDebugFile(outfile, { workflowFiles, serdeOnlyFiles });

    // Helper to create import statement from file path
    // For packages, uses the package name so esbuild will resolve through
    // package.json exports with conditions: ['workflow']
    const createImport = (file: string) => {
      const { importPath, isPackage } = getImportPath(
        file,
        this.config.workingDir
      );

      if (isPackage) {
        // Use package name - esbuild will resolve via package.json exports
        // and apply the 'workflow' condition
        return `import '${importPath}';`;
      }

      // Local app file - use relative path
      // Normalize both paths to forward slashes before calling relative()
      // This is critical on Windows where relative() can produce unexpected results with mixed path formats
      const normalizedWorkingDir = this.config.workingDir.replace(/\\/g, '/');
      const normalizedFile = file.replace(/\\/g, '/');
      // Calculate relative path from working directory to the file
      let relativePath = relative(normalizedWorkingDir, normalizedFile).replace(
        /\\/g,
        '/'
      );
      // Ensure relative paths start with ./ so esbuild resolves them correctly.
      // Paths like ".output/..." are not valid relative specifiers and must
      // become "./.output/...".
      if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
        relativePath = `./${relativePath}`;
      }
      return `import '${relativePath}';`;
    };

    // Create a virtual entry that imports all workflow files. Dedupe by
    // canonical module identity so source/dist copies of the same workspace
    // package export don't both get imported (which would make the swc
    // plugin generate duplicate workflow IDs).
    const emittedImportIdentities = new Set<string>();
    const buildImports = (files: string[]): string =>
      files
        .filter((file) => {
          const identity = moduleIdentityKey(file, this.moduleSpecifierRoot);
          if (emittedImportIdentities.has(identity)) return false;
          emittedImportIdentities.add(identity);
          return true;
        })
        .map(createImport)
        .join('\n');

    // The SWC plugin in workflow mode emits `globalThis.__private_workflows.set(workflowId, fn)`
    // calls directly, so we just need to import the files (Map is initialized via banner)
    const workflowImports = buildImports(workflowFiles);

    // Include serde-only files for class registration side effects
    const serdeImports = buildImports(serdeOnlyFiles);

    const imports = serdeImports
      ? `${workflowImports}\n// Serde files for cross-context class registration\n${serdeImports}`
      : workflowImports;

    const bundleStartTime = Date.now();
    const workflowManifest: WorkflowManifest = {};
    const esbuildTsconfigOptions =
      await getEsbuildTsconfigOptions(tsconfigPath);
    const normalizedWorkflowSideEffectEntries = await withRealpaths([
      ...workflowFiles,
      ...serdeOnlyFiles,
    ]);

    // Bundle with esbuild and our custom SWC plugin in workflow mode.
    // this bundle will be run inside a vm isolate
    const interimBundleCtx = await esbuild.context({
      stdin: {
        contents: imports,
        resolveDir: this.config.workingDir,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      bundle: true,
      absWorkingDir: this.config.workingDir,
      format: 'cjs', // Runs inside the VM which expects cjs
      platform: 'neutral', // The platform is neither node nor browser
      mainFields: ['module', 'main'], // To support npm style imports
      conditions: ['workflow'], // Allow packages to export 'workflow' compliant versions
      target: 'es2022',
      write: false,
      treeShaking: true,
      keepNames: true,
      minify: false,
      // Initialize the workflow registry at the very top of the bundle
      // This must be in banner (not the virtual entry) because esbuild's bundling
      // can reorder code, and the .set() calls need the Map to exist first
      banner: {
        js: 'globalThis.__private_workflows = new Map();',
      },
      // Source maps for better stack traces in workflow VM execution. This
      // intermediate bundle is executed via runInContext() in a VM, so inline
      // source maps give meaningful stack traces instead of
      // "evalmachine.<anonymous>". Defaults to inline in development and off in
      // production (see `defaultSourcemapMode`) to keep production function
      // bundles small; override with the `sourcemap` config option or the
      // `WORKFLOW_SOURCEMAP` env var. The runtime remaps stacks only when a
      // map is present, so disabling maps degrades gracefully.
      sourcemap: this.resolveSourcemap(this.defaultSourcemapMode),
      // Use tsconfig for path alias resolution.
      // For symlinked configs this uses tsconfigRaw to preserve cwd-relative aliases.
      ...esbuildTsconfigOptions,
      resolveExtensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
      ],
      plugins: [
        // Handle pseudo-packages like 'server-only' and 'client-only' by providing
        // empty modules. Must run first to intercept these before other resolution.
        createPseudoPackagePlugin(),
        createSwcPlugin({
          mode: 'workflow',
          projectRoot: this.transformProjectRoot,
          moduleSpecifierRoot: this.moduleSpecifierRoot,
          workflowManifest,
          sideEffectEntries: normalizedWorkflowSideEffectEntries,
        }),
        // This plugin must run after the swc plugin to ensure dead code elimination
        // happens first, preventing false positives on Node.js imports in unused code paths
        createNodeModuleErrorPlugin(),
      ],
      // NOTE: We intentionally do NOT use the external option here for workflow bundles.
      // When packages are marked external with format: 'cjs', esbuild generates require() calls.
      // However, the workflow VM (vm.runInContext) does not have require() defined - it only
      // provides module.exports and exports. External packages would fail at runtime with:
      //   ReferenceError: require is not defined
      // Instead, we bundle everything and rely on:
      // - createPseudoPackagePlugin() to handle server-only/client-only with empty modules
      // - createNodeModuleErrorPlugin() to catch Node.js builtin imports at build time
    });
    let shouldDisposeInterimBundleCtx = !keepInterimBundleContext;
    try {
      const interimBundle = await interimBundleCtx.rebuild();

      this.logEsbuildMessages(
        interimBundle,
        'intermediate workflow bundle',
        true,
        {
          suppressWarnings: this.config.suppressCreateWorkflowsBundleWarnings,
        }
      );
      this.logCreateWorkflowsBundleInfo(
        'Created intermediate workflow bundle',
        `${Date.now() - bundleStartTime}ms`
      );

      if (this.config.workflowManifestPath) {
        const resolvedPath = resolve(
          process.cwd(),
          this.config.workflowManifestPath
        );
        let prefix = '';

        if (resolvedPath.endsWith('.cjs')) {
          prefix = 'module.exports = ';
        } else if (
          resolvedPath.endsWith('.js') ||
          resolvedPath.endsWith('.mjs')
        ) {
          prefix = 'export default ';
        }

        await mkdir(dirname(resolvedPath), { recursive: true });
        await writeFile(
          resolvedPath,
          prefix + JSON.stringify(workflowManifest, null, 2)
        );
      }

      await this.ensureSwcIgnored();

      if (
        !interimBundle.outputFiles ||
        interimBundle.outputFiles.length === 0
      ) {
        throw new WorkflowBuildError('No output files generated from esbuild', {
          hint: 'This usually indicates a misconfigured entry point or an empty workflow directory. Check that your workflow files contain a `"use workflow"` or `"use step"` directive.',
        });
      }

      // Serde compliance warnings: check if workflow bundle has Node.js imports
      // alongside serde-registered classes (these will fail at runtime in the sandbox)
      if (
        workflowManifest.classes &&
        Object.keys(workflowManifest.classes).length > 0
      ) {
        const { analyzeSerdeCompliance } = await import('./serde-checker.js');
        const bundleText = interimBundle.outputFiles[0].text;
        const serdeResult = analyzeSerdeCompliance({
          sourceCode: '',
          workflowCode: bundleText,
          manifest: workflowManifest,
        });
        // De-dupe warnings: group identical issues across classes
        const issuesToClasses = new Map<string, Set<string>>();
        for (const cls of serdeResult.classes) {
          if (!cls.compliant) {
            for (const issue of cls.issues) {
              let affectedClasses = issuesToClasses.get(issue);
              if (!affectedClasses) {
                affectedClasses = new Set<string>();
                issuesToClasses.set(issue, affectedClasses);
              }
              affectedClasses.add(cls.className);
            }
          }
        }
        for (const [issue, affectedClasses] of issuesToClasses) {
          const classNames = [...affectedClasses];
          const classLabel =
            classNames.length === 1
              ? `class "${classNames[0]}"`
              : `classes ${classNames.map((name) => `"${name}"`).join(', ')}`;
          console.warn(
            chalk.yellow(`⚠ Serde warning for ${classLabel}: `) + issue
          );
        }
      }

      const workflowEntrypointOptionsCode = createWorkflowEntrypointOptionsCode(
        {
          routeModuleBodyStartedAt: 'workflowRouteModuleBodyStartedAt',
        }
      );

      const bundleFinal = async (interimBundle: string) => {
        const workflowBundleCode = interimBundle;

        const workflowFunctionCode = `// biome-ignore-all lint: generated file
/* eslint-disable */
import { workflowEntrypoint } from 'workflow/runtime';

const workflowRouteModuleBodyStartedAt = Date.now();
const workflowCode = \`${workflowBundleCode.replace(/[\\`$]/g, '\\$&')}\`;

export const POST = workflowEntrypoint(workflowCode${workflowEntrypointOptionsCode});`;

        // we skip the final bundling step for Next.js so it can bundle itself
        if (!bundleFinalOutput) {
          if (!outfile) {
            throw new Error(`Invariant: missing outfile for workflow bundle`);
          }
          // Ensure the output directory exists
          const outputDir = dirname(outfile);
          await mkdir(outputDir, { recursive: true });

          await this.writeGeneratedFile(outfile, workflowFunctionCode);
          return;
        }

        const bundleStartTime = Date.now();

        // Now bundle this so we can resolve the @workflow/core dependency
        // we could remove this if we do nft tracing or similar instead
        const finalEsmRequireBanner = this.getEsmRequireBanner(format);
        const finalWorkflowResult = await esbuild.build({
          banner: {
            js: `// biome-ignore-all lint: generated file\n/* eslint-disable */\n${finalEsmRequireBanner}`,
          },
          stdin: {
            contents: workflowFunctionCode,
            resolveDir: this.config.workingDir,
            sourcefile: 'virtual-entry.js',
            loader: 'js',
          },
          outfile,
          // Source maps for the final workflow bundle wrapper (not important since this code
          // doesn't run in the VM - only the intermediate bundle sourcemap is relevant)
          sourcemap: this.resolveSourcemap(EMIT_SOURCEMAPS_FOR_DEBUGGING),
          absWorkingDir: this.config.workingDir,
          bundle: true,
          format,
          platform: 'node',
          target: 'es2022',
          write: true,
          keepNames: true,
          minify: false,
          plugins: [this.createWorkflowWorldTargetPlugin()],
          external: ['@aws-sdk/credential-provider-web-identity'],
        });

        this.logEsbuildMessages(
          finalWorkflowResult,
          'final workflow bundle',
          true,
          {
            suppressWarnings: this.config.suppressCreateWorkflowsBundleWarnings,
          }
        );
        this.logCreateWorkflowsBundleInfo(
          'Created final workflow bundle',
          `${Date.now() - bundleStartTime}ms`
        );
      };
      const interimBundleText = interimBundle.outputFiles[0].text;
      await bundleFinal(interimBundleText);

      if (keepInterimBundleContext) {
        shouldDisposeInterimBundleCtx = false;
        return {
          manifest: workflowManifest,
          interimBundleCtx,
          bundleFinal,
          interimBundleText,
        };
      }
      return { manifest: workflowManifest, interimBundleText };
    } catch (error) {
      shouldDisposeInterimBundleCtx = true;
      throw error;
    } finally {
      if (shouldDisposeInterimBundleCtx) {
        try {
          await interimBundleCtx.dispose();
        } catch (disposeError) {
          console.warn(
            'Warning: Failed to dispose workflow bundle context',
            disposeError
          );
        }
      }
    }
  }

  /**
   * V2: Creates a combined bundle that includes both step registrations and
   * workflow orchestration in a single route. The combined entrypoint executes
   * steps inline when possible, reducing function invocations and queue overhead.
   *
   * This method reuses createStepsBundle (for step registrations) and
   * createWorkflowsBundle (for workflow VM code), then combines them into
   * a single route file using workflowEntrypoint().
   */
  protected async createCombinedBundle({
    inputFiles,
    stepsOutfile,
    flowOutfile,
    format = 'esm',
    bundleFinalOutput = true,
    tsconfigPath,
    externalizeNonSteps,
    bundleTransitiveLocalStepDependencies,
    sourceStepRegistrationImports,
    discoveredEntries,
  }: {
    inputFiles: string[];
    /** Output path for the step registrations bundle (side effects only) */
    stepsOutfile: string;
    /** Output path for the combined route file */
    flowOutfile: string;
    format?: 'cjs' | 'esm';
    bundleFinalOutput?: boolean;
    tsconfigPath?: string;
    externalizeNonSteps?: boolean;
    bundleTransitiveLocalStepDependencies?: boolean;
    sourceStepRegistrationImports?: boolean;
    discoveredEntries?: DiscoveredEntries;
  }): Promise<{
    manifest: WorkflowManifest;
    stepsContext?: esbuild.BuildContext;
    interimBundleCtx?: esbuild.BuildContext;
    workflowInterimBundleText?: string;
    bundleFinal?: (interimBundleResult: string) => Promise<void>;
    discoveredEntries: DiscoveredEntries;
    stepsManifest: WorkflowManifest;
    workflowsManifest: WorkflowManifest;
  }> {
    this.startWorkflowBuildTimer();
    const effectiveDiscoveredEntries =
      discoveredEntries ??
      (await this.discoverEntries(
        inputFiles,
        dirname(flowOutfile),
        tsconfigPath
      ));

    // 1. Build step registrations bundle (used as separate file for
    // bundleFinalOutput: false, or read back for inline content when true)
    const { context: stepsContext, manifest: stepsManifest } =
      await this.createStepsBundle({
        inputFiles,
        outfile: stepsOutfile,
        // When bundleFinalOutput is true, use ESM for the steps bundle
        // regardless of the final output format. The final esbuild pass
        // converts everything to the target format. Using CJS here causes
        // a module.exports collision: the steps bundle's top-level
        // module.exports overwrites the combined route's module.exports
        // when esbuild inlines the steps without a __commonJS wrapper.
        format: bundleFinalOutput ? 'esm' : format,
        externalizeNonSteps,
        bundleTransitiveLocalStepDependencies,
        sourceStepRegistrationImports,
        tsconfigPath,
        discoveredEntries: effectiveDiscoveredEntries,
        // Skip the createRequire banner here — when bundleFinalOutput is true
        // the outer esbuild pass will inline this bundle and add its own
        // banner. Emitting it twice declares __createRequire twice.
        skipEsmRequireBanner: bundleFinalOutput,
      });

    // 2. Build workflow VM code
    const tempWorkflowOutfile = `${flowOutfile}.__wf_tmp.js`;
    const workflowsResult = await this.createWorkflowsBundle({
      inputFiles,
      outfile: tempWorkflowOutfile,
      format,
      bundleFinalOutput: false,
      tsconfigPath,
      discoveredEntries: effectiveDiscoveredEntries,
    });

    const workflowVMCode = workflowsResult.interimBundleText;
    if (!workflowVMCode) {
      throw new Error('createWorkflowsBundle did not return interimBundleText');
    }

    // Clean up the wrapper file
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tempWorkflowOutfile);
    } catch {
      // Ignore cleanup errors
    }

    // 3. Generate combined route file
    const stepsRelativePath = `./${basename(stepsOutfile).replace(/\\/g, '/')}`;
    const escapedVMCode = workflowVMCode.replace(/[\\`$]/g, '\\$&');
    const workflowEntrypointOptionsCode = createWorkflowEntrypointOptionsCode({
      routeModuleBodyStartedAt: 'workflowRouteModuleBodyStartedAt',
    });

    const combinedFunctionCode = `// biome-ignore-all lint: generated file
/* eslint-disable */
import { __steps_registered } from '${stepsRelativePath}';
import { workflowEntrypoint } from 'workflow/runtime';

const workflowRouteModuleBodyStartedAt = Date.now();

// Prevent rollup from tree-shaking the steps side-effect import
void __steps_registered;

const workflowCode = \`${escapedVMCode}\`;

export const POST = workflowEntrypoint(workflowCode${workflowEntrypointOptionsCode});`;

    if (!bundleFinalOutput) {
      await this.writeGeneratedFile(flowOutfile, combinedFunctionCode);
    } else {
      // Bundle the combined code for standalone use
      const bundleStartTime = Date.now();
      const { banner: importMetaBanner, define: importMetaDefine } =
        this.getCjsImportMetaPolyfill(format);
      // ESM banner provides `require` via createRequire(import.meta.url) so
      // CJS dependencies that call require() for Node.js builtins keep working
      // in the ESM output produced by bundleFinalOutput: true.
      const finalEsmRequireBanner = this.getEsmRequireBanner(format);
      const finalResult = await esbuild.build({
        banner: {
          js: `// biome-ignore-all lint: generated file\n/* eslint-disable */\n${importMetaBanner}${finalEsmRequireBanner}`,
        },
        stdin: {
          contents: combinedFunctionCode,
          resolveDir: dirname(flowOutfile),
          sourcefile: 'virtual-entry.js',
          loader: 'js',
        },
        outfile: flowOutfile,
        absWorkingDir: this.config.workingDir,
        bundle: true,
        format,
        platform: 'node',
        target: 'es2022',
        write: true,
        keepNames: true,
        minify: false,
        define: importMetaDefine,
        plugins: [this.createWorkflowWorldTargetPlugin()],
        external: ['@aws-sdk/credential-provider-web-identity'],
      });
      this.logEsbuildMessages(finalResult, 'combined bundle', true);
      this.logBaseBuilderInfo(
        'Created combined bundle',
        `${Date.now() - bundleStartTime}ms`
      );
    }

    // Merge manifests
    const manifest: WorkflowManifest = {
      ...stepsManifest,
      workflows: {
        ...stepsManifest.workflows,
        ...workflowsResult.manifest.workflows,
      },
      classes: {
        ...stepsManifest.classes,
        ...workflowsResult.manifest.classes,
      },
    };

    // Create a custom bundleFinal for watch mode that uses workflowEntrypoint
    let combinedRouteWriteId = 0;
    const combinedBundleFinal = async (interimBundleText: string) => {
      combinedRouteWriteId++;
      const escaped = interimBundleText.replace(/[\\`$]/g, '\\$&');
      const workflowEntrypointOptionsCode = createWorkflowEntrypointOptionsCode(
        {
          routeModuleBodyStartedAt: 'workflowRouteModuleBodyStartedAt',
        }
      );
      const code = `// biome-ignore-all lint: generated file
/* eslint-disable */
// workflow route refresh ${combinedRouteWriteId}
import { __steps_registered } from '${stepsRelativePath}';
import { workflowEntrypoint } from 'workflow/runtime';

const workflowRouteModuleBodyStartedAt = Date.now();

void __steps_registered;

const workflowCode = \`${escaped}\`;

export const POST = workflowEntrypoint(workflowCode${workflowEntrypointOptionsCode});`;

      const outputDir = dirname(flowOutfile);
      await mkdir(outputDir, { recursive: true });
      await this.writeGeneratedFile(flowOutfile, code);
    };

    if (this.config.watch) {
      return {
        manifest,
        stepsContext,
        interimBundleCtx: workflowsResult.interimBundleCtx,
        workflowInterimBundleText: workflowVMCode,
        bundleFinal: combinedBundleFinal,
        discoveredEntries: effectiveDiscoveredEntries,
        stepsManifest,
        workflowsManifest: workflowsResult.manifest,
      };
    }

    return {
      manifest,
      discoveredEntries: effectiveDiscoveredEntries,
      stepsManifest,
      workflowsManifest: workflowsResult.manifest,
    };
  }

  /**
   * Creates a client library bundle for workflow execution.
   * The client library allows importing and calling workflows from application code.
   * Only generated if clientBundlePath is specified in config.
   */
  protected async createClientLibrary(): Promise<void> {
    if (!this.config.clientBundlePath) {
      // Silently exit since no client bundle was requested
      return;
    }

    this.logBaseBuilderInfo(
      'Generating a client library at',
      this.config.clientBundlePath
    );
    this.logBaseBuilderInfo(
      'NOTE: The recommended way to use workflow with a framework like NextJS is using the loader/plugin with webpack/turbobpack/rollup'
    );

    // Ensure we have the directory for the client bundle
    const outputDir = dirname(this.config.clientBundlePath);
    await mkdir(outputDir, { recursive: true });

    const inputFiles = await this.filterExistingFilesForWatch(
      await this.getInputFiles(),
      'client input files'
    );

    // Discover serde files from the input files' dependency tree for cross-context class registration.
    // Classes need to be registered in the client bundle so they can be serialized
    // when passing data to workflows via start() and deserialized when receiving workflow results.
    const { discoveredSerdeFiles } = await this.discoverEntries(
      inputFiles,
      outputDir
    );

    // Identify serde files that aren't in the inputFiles (deduplicated)
    const inputFilesNormalized = new Set(
      inputFiles.map((f) => f.replace(/\\/g, '/'))
    );
    const serdeOnlyFiles = [...discoveredSerdeFiles].filter(
      (f) => !inputFilesNormalized.has(f)
    );

    // Re-exports for input files (user's workflow/step definitions).
    // These must use valid relative specifiers because some frameworks pass
    // generated files like ".output/server/index.mjs" as input files.
    const reexports = inputFiles
      .map((file) => {
        const normalizedWorkingDir = this.config.workingDir.replace(/\\/g, '/');
        let relativePath = relative(normalizedWorkingDir, file).replace(
          /\\/g,
          '/'
        );
        if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
          relativePath = `./${relativePath}`;
        }
        return `export * from '${relativePath}';`;
      })
      .join('\n');

    // Side-effect imports for serde files not in inputFiles (for class registration)
    const serdeImports = serdeOnlyFiles
      .map((file) => {
        const normalizedWorkingDir = this.config.workingDir.replace(/\\/g, '/');
        let relativePath = relative(normalizedWorkingDir, file).replace(
          /\\/g,
          '/'
        );
        if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
          relativePath = `./${relativePath}`;
        }
        return `import '${relativePath}';`;
      })
      .join('\n');

    // Combine: serde imports (for registration side effects) + re-exports
    const entryContent = serdeImports
      ? `// Serde files for cross-context class registration\n${serdeImports}\n${reexports}`
      : reexports;

    // Bundle with esbuild and our custom SWC plugin
    const normalizedClientSideEffectEntries = await withRealpaths([
      ...inputFiles,
      ...serdeOnlyFiles,
    ]);
    const clientResult = await esbuild.build({
      banner: {
        js: '// biome-ignore-all lint: generated file\n/* eslint-disable */\n',
      },
      stdin: {
        contents: entryContent,
        resolveDir: this.config.workingDir,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      outfile: this.config.clientBundlePath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'preserve',
      target: 'es2022',
      write: true,
      treeShaking: true,
      external: ['@workflow/core'],
      resolveExtensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
      ],
      plugins: [
        createSwcPlugin({
          mode: 'step',
          projectRoot: this.transformProjectRoot,
          moduleSpecifierRoot: this.moduleSpecifierRoot,
          sideEffectEntries: normalizedClientSideEffectEntries,
        }),
      ],
    });

    this.logEsbuildMessages(clientResult, 'client library bundle');

    await this.ensureSwcIgnored();
  }

  /**
   * Creates a webhook handler bundle for resuming workflows via HTTP callbacks.
   *
   * @param bundle - If true, bundles dependencies (needed for Build Output API)
   */
  protected async createWebhookBundle({
    outfile,
    bundle = false,
  }: {
    outfile: string;
    bundle?: boolean;
  }): Promise<void> {
    this.logCreateWebhookBundleInfo('Creating webhook route');
    await mkdir(dirname(outfile), { recursive: true });

    // Create a static route that calls resumeWebhook
    // This route works for both Next.js and Vercel Build Output API
    // Bundled Build Output API webhook functions need world.ts statically
    // present so getWorldLazy() can use the global getWorld registration
    // instead of falling back to a missing sibling import("./world.js").
    const routeContent = `${bundle ? "import 'workflow/runtime';\n" : ''}import { resumeWebhook } from 'workflow/api';

async function handler(request) {
  const url = new URL(request.url);
  // Extract token from pathname: /.well-known/workflow/v1/webhook/{token}
  const pathParts = url.pathname.split('/');
  const token = decodeURIComponent(pathParts[pathParts.length - 1]);

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  try {
    const response = await resumeWebhook(token, request);
    return response;
  } catch (error) {
    // TODO: differentiate between invalid token and other errors
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
export const OPTIONS = handler;`;

    if (!bundle) {
      // For Next.js, just write the unbundled file
      await writeFile(outfile, routeContent);
      return;
    }

    // For Build Output API, bundle with esbuild to resolve imports

    const webhookEsmRequireBanner = this.getEsmRequireBanner('esm');
    const webhookBundleStart = Date.now();
    const result = await esbuild.build({
      banner: {
        js: `// biome-ignore-all lint: generated file\n/* eslint-disable */\n${webhookEsmRequireBanner}`,
      },
      stdin: {
        contents: routeContent,
        resolveDir: this.config.workingDir,
        sourcefile: 'webhook-route.js',
        loader: 'js',
      },
      outfile,
      absWorkingDir: this.config.workingDir,
      bundle: true,
      jsx: 'preserve',
      format: 'esm',
      platform: 'node',
      conditions: ['import', 'module', 'node', 'default'],
      target: 'es2022',
      write: true,
      treeShaking: true,
      keepNames: true,
      minify: false,
      resolveExtensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
      ],
      sourcemap: this.resolveSourcemap(EMIT_SOURCEMAPS_FOR_DEBUGGING),
      mainFields: ['module', 'main'],
      plugins: [this.createWorkflowWorldTargetPlugin()],
      // Don't externalize anything - bundle everything including workflow packages
      external: [],
    });

    this.logEsbuildMessages(result, 'webhook bundle creation');
    this.logCreateWebhookBundleInfo(
      'Created webhook bundle',
      `${Date.now() - webhookBundleStart}ms`
    );
  }

  /**
   * Creates a package.json file with the specified module type.
   */
  protected async createPackageJson(
    dir: string,
    type: 'commonjs' | 'module'
  ): Promise<void> {
    const packageJson = { type };
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
  }

  /**
   * Creates a .vc-config.json file for Vercel Build Output API functions.
   */
  protected async createVcConfig(
    dir: string,
    config: {
      runtime?: string;
      handler?: string;
      launcherType?: string;
      architecture?: string;
      shouldAddHelpers?: boolean;
      shouldAddSourcemapSupport?: boolean;
      maxDuration?: number | 'max';
      experimentalTriggers?: Array<{
        type: 'queue/v2beta';
        topic: string;
        consumer: string;
        maxDeliveries?: number;
        retryAfterSeconds?: number;
        initialDelaySeconds?: number;
      }>;
    }
  ): Promise<void> {
    const vcConfig = {
      runtime: config.runtime ?? 'nodejs22.x',
      handler: config.handler ?? 'index.mjs',
      launcherType: config.launcherType ?? 'Nodejs',
      architecture: config.architecture ?? 'arm64',
      shouldAddHelpers: config.shouldAddHelpers ?? true,
      ...(config.maxDuration !== undefined && {
        maxDuration: config.maxDuration,
      }),
      ...(config.shouldAddSourcemapSupport !== undefined && {
        shouldAddSourcemapSupport: config.shouldAddSourcemapSupport,
      }),
      ...(config.experimentalTriggers && {
        experimentalTriggers: config.experimentalTriggers,
      }),
    };

    await writeFile(
      join(dir, '.vc-config.json'),
      JSON.stringify(vcConfig, null, 2)
    );
  }

  /**
   * Resolves a path relative to the working directory.
   */
  protected resolvePath(path: string): string {
    return resolve(this.config.workingDir, path);
  }

  /**
   * Ensures the directory for a file path exists, creating it if necessary.
   */
  protected async ensureDirectory(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
  }

  protected async ensureSwcIgnored(): Promise<void> {
    await this.ensureProjectSwcGitignoreEntry();
    await this.createSwcDirectoryGitignore();
  }

  private async ensureProjectSwcGitignoreEntry(): Promise<void> {
    const gitignorePath = join(this.config.workingDir, '.gitignore');

    try {
      let content = '';
      try {
        content = await readFile(gitignorePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return;
        }
      }

      const hasSwcEntry = content.split(/\r?\n/).some((line) => {
        const trimmed = line.trim();
        return (
          trimmed === '.swc' ||
          trimmed === '.swc/' ||
          trimmed === '/.swc' ||
          trimmed === '/.swc/'
        );
      });

      if (hasSwcEntry) {
        return;
      }

      const separator =
        content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      await writeFile(gitignorePath, `${content}${separator}/.swc\n`);
    } catch {
      // We're intentionally silently ignoring this error - updating .gitignore isn't critical
    }
  }

  private async createSwcDirectoryGitignore(): Promise<void> {
    try {
      await writeFile(
        join(this.config.workingDir, '.swc', '.gitignore'),
        '*\n'
      );
    } catch {
      // We're intentionally silently ignoring this error - creating .gitignore isn't critical
    }
  }

  /**
   * Whether the manifest should be exposed as a public HTTP route.
   * Controlled by the `WORKFLOW_PUBLIC_MANIFEST` environment variable.
   */
  protected get shouldExposePublicManifest(): boolean {
    return process.env.WORKFLOW_PUBLIC_MANIFEST === '1';
  }

  /**
   * Resolves the workflow manifest diagnostics path, when this builder should
   * emit one.
   */
  protected getDiagnosticsManifestPath(): string | undefined {
    if (this.config.diagnosticsDir) {
      return resolve(
        this.config.workingDir,
        this.config.diagnosticsDir,
        'workflows-manifest.json'
      );
    }

    if (this.config.buildTarget === 'vercel-build-output-api') {
      return this.resolvePath(
        '.vercel/output/diagnostics/workflows-manifest.json'
      );
    }
  }

  /**
   * Whether this is a development/watch build (e.g. `next dev`, `nitro dev`,
   * or a Vite-based dev server for astro/sveltekit/vite). `config.watch` is
   * plumbed by the builders that own a dev server (next, nitro, nest); the
   * Vite-based integrations don't set it but run with
   * `NODE_ENV === 'development'`. When neither signal is present we treat the
   * build as production, so CLI/Vercel production builds default to off.
   */
  protected get isDevelopmentBuild(): boolean {
    return this.config.watch === true || process.env.NODE_ENV === 'development';
  }

  /**
   * Default source map mode for the stack-relevant bundles (steps + the
   * intermediate workflow VM bundle): inline source maps in development so
   * stack traces point at source files, and off in production so function
   * bundles stay small (helps stay under the Vercel 250MB function limit) and
   * skip the source-map-support runtime shim. The `sourcemap` config option
   * and `WORKFLOW_SOURCEMAP` env var override this in either environment.
   */
  protected get defaultSourcemapMode(): SourcemapMode {
    return this.isDevelopmentBuild ? 'inline' : false;
  }

  /**
   * Resolve the effective source map mode for a given call site. Precedence:
   * explicit `sourcemap` config > `WORKFLOW_SOURCEMAP` env var > the call
   * site's default. Returned value is passed directly to esbuild's
   * `sourcemap` option.
   */
  protected resolveSourcemap(defaultMode: SourcemapMode): SourcemapMode {
    if (this.config.sourcemap !== undefined) return this.config.sourcemap;
    const envMode = parseSourcemapEnv(process.env.WORKFLOW_SOURCEMAP);
    if (envMode !== undefined) return envMode;
    return defaultMode;
  }

  /**
   * Whether the resolved source map mode emits any source maps at all.
   * Used by consumers like the Vercel builder to decide whether to include
   * the source-map-support runtime shim in generated functions. Uses the same
   * environment-aware default (`defaultSourcemapMode`) as the step/workflow
   * bundles, so a production build with no override omits the shim.
   */
  protected get sourcemapsEnabled(): boolean {
    return this.resolveSourcemap(this.defaultSourcemapMode) !== false;
  }

  /**
   * Creates a manifest JSON file containing step/workflow/class metadata
   * and graph data for visualization.
   *
   * @returns The manifest JSON string, or undefined if manifest creation failed.
   */
  protected async createManifest({
    workflowBundlePath,
    manifestDir,
    manifest,
  }: {
    workflowBundlePath: string;
    manifestDir: string;
    manifest: WorkflowManifest;
  }): Promise<string | undefined> {
    const buildStart = Date.now();
    this.logCreateManifestInfo('Creating manifest...');

    try {
      const workflowGraphs = await extractWorkflowGraphs(workflowBundlePath);

      const steps = this.convertStepsManifest(manifest.steps);
      const workflows = this.convertWorkflowsManifest(
        manifest.workflows,
        workflowGraphs
      );
      const classes = this.convertClassesManifest(manifest.classes);

      const output = { version: '1.0.0', steps, workflows, classes };
      const manifestJson = JSON.stringify(output, null, 2);

      await mkdir(manifestDir, { recursive: true });
      await writeFile(join(manifestDir, 'manifest.json'), manifestJson);

      const diagnosticsManifestPath = this.getDiagnosticsManifestPath();
      if (diagnosticsManifestPath) {
        await this.ensureDirectory(diagnosticsManifestPath);
        await writeFile(diagnosticsManifestPath, manifestJson);
      }

      const stepCount = Object.values(steps).reduce(
        (acc, s) => acc + Object.keys(s).length,
        0
      );
      const workflowCount = Object.values(workflows).reduce(
        (acc, w) => acc + Object.keys(w).length,
        0
      );
      const classCount = Object.values(classes).reduce(
        (acc, c) => acc + Object.keys(c).length,
        0
      );

      this.logCreateManifestInfo(
        `Created manifest with ${stepCount} ${pluralize('step', 'steps', stepCount)}, ${workflowCount} ${pluralize('workflow', 'workflows', workflowCount)}, and ${classCount} ${pluralize('class', 'classes', classCount)}`,
        `${Date.now() - buildStart}ms`
      );

      if (!this.config.suppressCreateManifestLogs) {
        console.log(
          this.getWorkflowBuildSummary({
            stepCount,
            workflowCount,
          })
        );
      }
      this.resetWorkflowBuildTimer();

      return manifestJson;
    } catch (error) {
      console.warn(
        'Failed to create manifest:',
        error instanceof Error ? error.message : String(error)
      );
      this.resetWorkflowBuildTimer();
      return undefined;
    }
  }

  private convertStepsManifest(
    steps: WorkflowManifest['steps']
  ): Record<string, Record<string, { stepId: string }>> {
    const result: Record<string, Record<string, { stepId: string }>> = {};
    if (!steps) return result;

    for (const [filePath, entries] of Object.entries(steps)) {
      result[filePath] = {};
      for (const [name, data] of Object.entries(entries)) {
        result[filePath][name] = { stepId: data.stepId };
      }
    }
    return result;
  }

  private convertWorkflowsManifest(
    workflows: WorkflowManifest['workflows'],
    graphs: Record<
      string,
      Record<string, { graph: { nodes: any[]; edges: any[] } }>
    >
  ): Record<
    string,
    Record<
      string,
      { workflowId: string; graph: { nodes: any[]; edges: any[] } }
    >
  > {
    const result: Record<
      string,
      Record<
        string,
        { workflowId: string; graph: { nodes: any[]; edges: any[] } }
      >
    > = {};
    if (!workflows) return result;

    // Build a normalized lookup for graphs since the graph extractor uses
    // paths from workflowId (e.g. "./workflows/hello-agent") while the
    // manifest uses source file paths (e.g. "workflows/hello-agent.ts").
    // Normalize by stripping leading "./" and file extensions.
    const normalizedGraphs = new Map<
      string,
      Record<string, { graph: { nodes: any[]; edges: any[] } }>
    >();
    for (const [graphPath, graphEntries] of Object.entries(graphs)) {
      const normalized = graphPath
        .replace(/^\.\//, '')
        .replace(/\.[^/.]+$/, '');
      normalizedGraphs.set(normalized, graphEntries);
    }

    for (const [filePath, entries] of Object.entries(workflows)) {
      result[filePath] = {};
      // Normalize the manifest file path for lookup
      const normalizedFilePath = filePath
        .replace(/^\.\//, '')
        .replace(/\.[^/.]+$/, '');

      const graphEntries =
        graphs[filePath] || normalizedGraphs.get(normalizedFilePath);

      for (const [name, data] of Object.entries(entries)) {
        result[filePath][name] = {
          workflowId: data.workflowId,
          graph: graphEntries?.[name]?.graph || { nodes: [], edges: [] },
        };
      }
    }
    return result;
  }

  private convertClassesManifest(
    classes: WorkflowManifest['classes']
  ): Record<string, Record<string, { classId: string }>> {
    const result: Record<string, Record<string, { classId: string }>> = {};
    if (!classes) return result;

    for (const [filePath, entries] of Object.entries(classes)) {
      result[filePath] = {};
      for (const [name, data] of Object.entries(entries)) {
        result[filePath][name] = { classId: data.classId };
      }
    }
    return result;
  }
}
