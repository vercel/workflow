import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  resolveConfiguredProjectRoot,
  resolveProjectRoot,
  WORKFLOW_OPTIONAL_WS_NATIVE_MODULES,
} from '@workflow/builders';
import type { NextConfig } from 'next';
import semver from 'semver';
import { getNextBuilder } from './builder.js';

const VERCEL_WORLD_PACKAGE = '@workflow/world-vercel';
const QUEUE_PACKAGE = '@vercel/queue';
// Bundling `@vercel/queue` requires the version whose dynamic `import()` carries
// `turbopackIgnore`/`webpackIgnore` annotations. Without them Turbopack cannot
// resolve that import ("server relative imports are not implemented yet") and
// fails the build, so an older copy has to stay external.
const QUEUE_MIN_BUNDLABLE_VERSION = '0.5.0';
// `@vercel/oidc` reaches `@vercel/cli-config`, and `@vercel/cli-auth` reaches
// both that and `@napi-rs/keyring`. Those are CLI-shaped dependencies that never
// run on a server: `xdg-app-paths` builds its config directory at module scope
// and throws `The "path" argument must be of type string` once bundled, which
// fails page-data collection. Keeping the three external stops any bundler from
// walking into that tree.
const VERCEL_WORLD_SERVER_EXTERNAL_PACKAGES = [
  '@vercel/oidc',
  '@vercel/cli-auth',
  '@napi-rs/keyring',
];
// `@workflow/world-vercel` and the queue client are bundled into the Next.js
// server build. Every module left external has to be resolved from disk on a
// cold start, one file at a time, and `register()` in `instrumentation.ts` sits
// in front of the first request. Bundling the world cuts the module count for
// that import from ~440 to ~250 and takes ~50ms off `register()`.
const VERCEL_WORLD_DEPENDENCY_PACKAGES = [
  QUEUE_PACKAGE,
  ...VERCEL_WORLD_SERVER_EXTERNAL_PACKAGES,
];
// The workflow and step bundles are built by esbuild, which resolves the
// dynamic import fine but gains nothing from inlining the world: those bundles
// are loaded once per invocation either way.
const WORKFLOW_BUNDLE_EXTERNAL_PACKAGES = [
  VERCEL_WORLD_PACKAGE,
  ...VERCEL_WORLD_DEPENDENCY_PACKAGES,
];
const useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m;
const useStepPattern = /^\s*(['"])use step\1;?\s*$/m;
const workflowSerdeImportPattern = /from\s+(['"])@workflow\/serde\1/;
const workflowSerdeSymbolPattern =
  /Symbol\.for\s*\(\s*(['"])workflow-(?:serialize|deserialize)\1\s*\)/;
const workflowSerdeComputedPropertyPattern =
  /\[\s*WORKFLOW_(?:SERIALIZE|DESERIALIZE)\s*\]/;

const PSEUDO_EXTERNAL_PACKAGES = new Set(['server-only', 'client-only']);
const warnedAutoRemovedServerExternalPackages = new Set<string>();
const BASE_PATH_SYMBOL = Symbol.for('@workflow/core/basePath');
const globalConfig = globalThis as typeof globalThis &
  Record<symbol, string | undefined>;

// Keep this local: @workflow/next is CommonJS, while @workflow/utils is ESM-only.
function setWorkflowBasePath(basePath: string | undefined): void {
  globalConfig[BASE_PATH_SYMBOL] = basePath ?? '';
}

interface WorkflowPatternMatch {
  hasUseWorkflow: boolean;
  hasUseStep: boolean;
  hasSerde: boolean;
}

interface DetectedServerExternalPackage {
  packageName: string;
  hasUseWorkflow: boolean;
  hasUseStep: boolean;
  hasSerde: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResolvablePackageSpecifier(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return false;
  }
  if (specifier.startsWith('$')) {
    return false;
  }
  if (specifier.includes('*') || specifier.includes(':')) {
    return false;
  }

  return true;
}

function detectWorkflowPatterns(source: string): WorkflowPatternMatch {
  const hasUseWorkflow = useWorkflowPattern.test(source);
  const hasUseStep = useStepPattern.test(source);
  const hasSerdeImport = workflowSerdeImportPattern.test(source);
  const hasSerdeSymbol = workflowSerdeSymbolPattern.test(source);
  const hasSerdeComputedProperty =
    workflowSerdeComputedPropertyPattern.test(source);

  return {
    hasUseWorkflow,
    hasUseStep,
    hasSerde: hasSerdeImport || hasSerdeSymbol || hasSerdeComputedProperty,
  };
}

function getIssueLabels(detected: DetectedServerExternalPackage): string[] {
  const issues: string[] = [];
  if (detected.hasUseWorkflow) {
    issues.push('"use workflow" functions');
  }
  if (detected.hasUseStep) {
    issues.push('"use step" functions');
  }
  if (detected.hasSerde) {
    issues.push('serialization classes');
  }
  return issues;
}

function hasWorkflowSerdeDependency(packageJson: unknown): boolean {
  if (!isPlainObject(packageJson)) {
    return false;
  }

  const dependencies = isPlainObject(packageJson.dependencies)
    ? packageJson.dependencies
    : {};
  const peerDependencies = isPlainObject(packageJson.peerDependencies)
    ? packageJson.peerDependencies
    : {};

  return (
    Object.hasOwn(dependencies, '@workflow/serde') ||
    Object.hasOwn(peerDependencies, '@workflow/serde')
  );
}

async function detectServerExternalPackage(
  packageName: string,
  workingDir: string
): Promise<DetectedServerExternalPackage | null> {
  if (!isResolvablePackageSpecifier(packageName)) {
    return null;
  }

  let hasUseWorkflow = false;
  let hasUseStep = false;
  let hasSerde = false;

  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [workingDir],
    });
    const packageJsonSource = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonSource) as unknown;
    hasSerde = hasWorkflowSerdeDependency(packageJson);
  } catch {
    // Best-effort only. Continue to source scanning.
  }

  try {
    const entryPath = require.resolve(packageName, {
      paths: [workingDir],
    });
    const source = await readFile(entryPath, 'utf-8');
    const patterns = detectWorkflowPatterns(source);
    hasUseWorkflow = patterns.hasUseWorkflow;
    hasUseStep = patterns.hasUseStep;
    hasSerde ||= patterns.hasSerde;
  } catch {
    // Best-effort only. Use whichever signal we already have.
  }

  if (!hasUseWorkflow && !hasUseStep && !hasSerde) {
    return null;
  }

  return {
    packageName,
    hasUseWorkflow,
    hasUseStep,
    hasSerde,
  };
}

function warnAboutAutoRemovedServerExternalPackages(
  detectedPackages: DetectedServerExternalPackage[]
): void {
  const newlyDetectedPackages = detectedPackages.filter(({ packageName }) => {
    return !warnedAutoRemovedServerExternalPackages.has(packageName);
  });

  if (newlyDetectedPackages.length === 0) {
    return;
  }

  for (const { packageName } of newlyDetectedPackages) {
    warnedAutoRemovedServerExternalPackages.add(packageName);
  }

  const packageDescriptions = newlyDetectedPackages
    .map(
      (detected) =>
        `"${detected.packageName}" (${getIssueLabels(detected).join(', ')})`
    )
    .join(', ');
  const packageNames = newlyDetectedPackages
    .map((detected) => `"${detected.packageName}"`)
    .join(', ');

  console.warn(
    `\n⚠ Workflow found workflow code in serverExternalPackages: ${packageDescriptions}.` +
      `\n  Workflow removed the affected entries from serverExternalPackages for this build and is compiling the packages anyway.` +
      `\n  Remove ${packageNames} from serverExternalPackages in next.config to silence this warning.\n`
  );
}

function resolveNextVersion(workingDir: string): string {
  const errors: unknown[] = [];

  // Try resolving from the consuming project's working directory first.
  // This handles monorepo setups where `next` may not be hoisted to the
  // same location as `@workflow/next`.
  try {
    const packageJsonPath = require.resolve('next/package.json', {
      paths: [workingDir],
    });
    const resolvedPackageJson = require(packageJsonPath) as {
      version?: unknown;
    };
    if (typeof resolvedPackageJson.version === 'string') {
      return resolvedPackageJson.version;
    }
  } catch (e) {
    errors.push(e);
  }

  // Fall back to resolving relative to this package's location.
  try {
    const version = (require('next/package.json') as { version?: unknown })
      .version;
    if (typeof version === 'string') {
      return version;
    }
  } catch (e) {
    errors.push(e);
  }

  throw new AggregateError(
    errors,
    `Could not resolve Next.js version. Ensure \`next\` is installed in your project (working directory: ${workingDir}).`
  );
}

/**
 * Whether the `@vercel/queue` copy the consuming app resolves can be bundled.
 * Fails open: when the package is not resolvable from the app root, the app does
 * not import it directly and only `@workflow/world-vercel`'s own pinned copy is
 * in the module graph.
 */
function isBundlableQueueVersion(workingDir: string): boolean {
  let version: unknown;
  try {
    const packageJsonPath = require.resolve(`${QUEUE_PACKAGE}/package.json`, {
      paths: [workingDir],
    });
    version = (require(packageJsonPath) as { version?: unknown }).version;
  } catch {
    return true;
  }
  if (typeof version !== 'string' || !semver.valid(version)) {
    return true;
  }
  return semver.gte(version, QUEUE_MIN_BUNDLABLE_VERSION);
}

function fileExists(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

function getWorkflowManifestCopyPaths({
  projectDir,
  distDir,
}: {
  projectDir: string;
  distDir: string;
}): { manifestPath: string; diagnosticsManifestPath: string } | undefined {
  const manifestCandidates = [
    join(projectDir, 'app/.well-known/workflow/v1/manifest.json'),
    join(projectDir, 'src/app/.well-known/workflow/v1/manifest.json'),
    join(projectDir, 'public/.well-known/workflow/v1/manifest.json'),
  ];
  const manifestPath = manifestCandidates.find(fileExists);

  if (!manifestPath) {
    return;
  }

  const resolvedDistDir = isAbsolute(distDir)
    ? distDir
    : join(projectDir, distDir);
  const diagnosticsManifestPath = join(
    resolvedDistDir,
    'diagnostics',
    'workflows-manifest.json'
  );
  return { manifestPath, diagnosticsManifestPath };
}

async function copyWorkflowDiagnosticsManifest(metadata: {
  projectDir: string;
  distDir: string;
}): Promise<void> {
  const paths = getWorkflowManifestCopyPaths(metadata);
  if (!paths) {
    return;
  }

  const { manifestPath, diagnosticsManifestPath } = paths;
  await mkdir(dirname(diagnosticsManifestPath), { recursive: true });
  await copyFile(manifestPath, diagnosticsManifestPath);
}

function copyWorkflowDiagnosticsManifestSync(metadata: {
  projectDir: string;
  distDir: string;
}): void {
  const paths = getWorkflowManifestCopyPaths(metadata);
  if (!paths) {
    return;
  }

  const { manifestPath, diagnosticsManifestPath } = paths;
  mkdirSync(dirname(diagnosticsManifestPath), { recursive: true });
  copyFileSync(manifestPath, diagnosticsManifestPath);
}

function registerWorkflowDiagnosticsManifestCopy(metadata: {
  projectDir: string;
  distDir: string;
}): void {
  const marker = '__workflowDiagnosticsManifestCopies';
  const globalWithMarker = globalThis as typeof globalThis & {
    [marker]?: Array<{ projectDir: string; distDir: string }>;
  };

  if (!globalWithMarker[marker]) {
    globalWithMarker[marker] = [];
    process.once('exit', () => {
      for (const copyMetadata of globalWithMarker[marker] || []) {
        copyWorkflowDiagnosticsManifestSync(copyMetadata);
      }
    });
  }

  globalWithMarker[marker].push(metadata);
}

/**
 * Mark `ws`'s optional native accelerators external on the webpack server
 * build, which otherwise bundles their JS wrapper without the native `.node`
 * binding and throws "bufferUtil.mask is not a function" at runtime. See
 * `WORKFLOW_OPTIONAL_WS_NATIVE_MODULES`; `@workflow/rollup` handles the
 * Rollup/Vite/Nitro side.
 */
function externalizeWsNativeAccelerators(webpackConfig: {
  externals?: unknown;
}): void {
  const names = [...WORKFLOW_OPTIONAL_WS_NATIVE_MODULES];
  if (Array.isArray(webpackConfig.externals)) {
    webpackConfig.externals.push(...names);
  } else if (webpackConfig.externals) {
    webpackConfig.externals = [webpackConfig.externals, ...names];
  } else {
    webpackConfig.externals = names;
  }
}

export function withWorkflow(
  nextConfigOrFn:
    | NextConfig
    | ((
        phase: string,
        ctx: { defaultConfig: NextConfig }
      ) => Promise<NextConfig>),
  {
    workflows,
  }: {
    workflows?: {
      local?: {
        port?: number;
      };
      /**
       * Controls how source maps are emitted for workflow bundles. Accepts
       * the same values as esbuild's `sourcemap` option: `true`/`'inline'`
       * (default), `'linked'`, `'external'`, `'both'`, or `false` to omit
       * source maps. Can also be set via the `WORKFLOW_SOURCEMAP`
       * environment variable.
       */
      sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';
    };
  } = {}
) {
  if (!process.env.VERCEL_DEPLOYMENT_ID) {
    if (!process.env.WORKFLOW_TARGET_WORLD) {
      process.env.WORKFLOW_TARGET_WORLD = 'local';
      process.env.WORKFLOW_LOCAL_DATA_DIR = '.next/workflow-data';
    }
    const maybePort = workflows?.local?.port;
    if (maybePort) {
      process.env.PORT = maybePort.toString();
    }
  } else {
    if (!process.env.WORKFLOW_TARGET_WORLD) {
      process.env.WORKFLOW_TARGET_WORLD = 'vercel';
    }
  }

  return async function buildConfig(
    phase: string,
    ctx: { defaultConfig: NextConfig }
  ) {
    if (
      phase === 'phase-development-server' ||
      phase === 'phase-production-build'
    ) {
      const { prewarmWorkflowSwcPluginCache } = await import(
        './swc-plugin-cache.js'
      );
      // Loader workers inherit this cwd and read from the same SWC cache.
      prewarmWorkflowSwcPluginCache(process.cwd());
    }

    const loaderPath = require.resolve('./loader');
    let nextConfig: NextConfig;

    if (typeof nextConfigOrFn === 'function') {
      nextConfig = await nextConfigOrFn(phase, ctx);
    } else {
      nextConfig = nextConfigOrFn;
    }
    // shallow clone to avoid read-only on top-level
    nextConfig = Object.assign({}, nextConfig);
    const workflowBasePath = nextConfig.basePath;
    setWorkflowBasePath(workflowBasePath);
    nextConfig.serverExternalPackages = [
      ...new Set([
        ...(nextConfig.serverExternalPackages || []),
        ...VERCEL_WORLD_SERVER_EXTERNAL_PACKAGES,
        ...(isBundlableQueueVersion(process.cwd()) ? [] : [QUEUE_PACKAGE]),
      ]),
    ];
    const existingCompiler = nextConfig.compiler ?? {};
    const existingRunAfterProductionCompile = (
      existingCompiler as {
        runAfterProductionCompile?: (metadata: {
          projectDir: string;
          distDir: string;
        }) => Promise<void>;
      }
    ).runAfterProductionCompile;

    const configuredServerExternalPackages = Array.isArray(
      nextConfig.serverExternalPackages
    )
      ? nextConfig.serverExternalPackages
      : [];
    let effectiveServerExternalPackages = configuredServerExternalPackages;

    if (configuredServerExternalPackages.length > 0) {
      const detectedWorkflowPackages: DetectedServerExternalPackage[] = [];
      for (const packageName of configuredServerExternalPackages) {
        if (PSEUDO_EXTERNAL_PACKAGES.has(packageName)) {
          continue;
        }

        try {
          const detected = await detectServerExternalPackage(
            packageName,
            process.cwd()
          );
          if (detected) {
            detectedWorkflowPackages.push(detected);
          }
        } catch {
          // Best-effort only. Never block config generation.
        }
      }

      if (detectedWorkflowPackages.length > 0) {
        const removedPackages = new Set(
          detectedWorkflowPackages.map((detected) => detected.packageName)
        );
        effectiveServerExternalPackages =
          configuredServerExternalPackages.filter(
            (packageName) => !removedPackages.has(packageName)
          );
        nextConfig.serverExternalPackages = effectiveServerExternalPackages;
        warnAboutAutoRemovedServerExternalPackages(detectedWorkflowPackages);
      }
    }

    // configure the loader if turbopack is being used
    if (!nextConfig.turbopack) {
      nextConfig.turbopack = {};
    }
    if (!nextConfig.turbopack.rules) {
      nextConfig.turbopack.rules = {};
    }
    const existingRules = nextConfig.turbopack.rules as any;
    const workingDir = process.cwd();
    const nextVersion = resolveNextVersion(workingDir);
    const configuredProjectRoot =
      nextConfig.outputFileTracingRoot ?? nextConfig.turbopack?.root;
    const projectRoot = configuredProjectRoot
      ? resolveConfiguredProjectRoot(workingDir, configuredProjectRoot)
      : resolveProjectRoot(workingDir);
    const supportsTurboCondition = semver.gte(nextVersion, 'v16.0.0');

    const shouldWatch = process.env.NODE_ENV === 'development';
    let workflowBuilderPromise: Promise<any> | undefined;
    const distDir = nextConfig.distDir || '.next';

    nextConfig.compiler = {
      ...existingCompiler,
      runAfterProductionCompile: async (metadata) => {
        if (existingRunAfterProductionCompile) {
          await existingRunAfterProductionCompile(metadata);
        }
        await copyWorkflowDiagnosticsManifest(metadata);
        registerWorkflowDiagnosticsManifestCopy(metadata);
      },
    };

    const getWorkflowBuilder = async () => {
      if (!workflowBuilderPromise) {
        workflowBuilderPromise = (async () => {
          const NextBuilder = await getNextBuilder(nextVersion);
          return new NextBuilder({
            watch: shouldWatch,
            // getInputFiles filters the project to Next.js entrypoints
            dirs: ['.'],
            pageExtensions: nextConfig.pageExtensions ?? [
              'tsx',
              'ts',
              'jsx',
              'js',
            ],
            projectRoot,
            moduleSpecifierRoot: workingDir,
            workingDir,
            distDir,
            basePath: workflowBasePath,
            diagnosticsDir: `${distDir}/diagnostics`,
            buildTarget: 'next',
            workflowsBundlePath: '', // not used in base
            stepsBundlePath: '', // not used in base
            webhookBundlePath: '', // node used in base
            sourcemap: workflows?.sourcemap,
            externalPackages: [
              // server-only and client-only are pseudo-packages handled by Next.js
              // during its build process. We mark them as external to prevent esbuild
              // from failing when bundling code that imports them.
              // See: https://nextjs.org/docs/app/getting-started/server-and-client-components
              'server-only',
              'client-only',
              ...new Set([
                ...effectiveServerExternalPackages,
                ...WORKFLOW_BUNDLE_EXTERNAL_PACKAGES,
              ]),
            ],
          });
        })();
      }

      return workflowBuilderPromise;
    };

    for (const key of [
      '*.tsx',
      '*.ts',
      '*.jsx',
      '*.js',
      '*.mjs',
      '*.mts',
      '*.cjs',
      '*.cts',
    ]) {
      nextConfig.turbopack.rules[key] = {
        ...(supportsTurboCondition
          ? {
              condition: {
                // Use 'all' to combine: must match content AND must NOT be in generated path
                // Merge with any existing 'all' conditions from user config
                all: [
                  ...(existingRules[key]?.condition?.all || []),
                  // Exclude generated workflow route files from transformation
                  { not: { path: /[/\\]\.well-known[/\\]workflow[/\\]/ } },
                  // Match files with workflow directives or custom serialization patterns
                  // Uses backreferences (\2, \3) to ensure matching quote types
                  {
                    content:
                      /(use workflow|use step|from\s+(['"])@workflow\/serde\2|Symbol\.for\s*\(\s*(['"])workflow-(?:serialize|deserialize)\3\s*\))/,
                  },
                ],
              },
            }
          : {}),
        loaders: [...(existingRules[key]?.loaders || []), loaderPath],
      };
    }

    // configure the loader for webpack
    const existingWebpackModify = nextConfig.webpack;
    nextConfig.webpack = (...args) => {
      const [webpackConfig] = args;
      if (!webpackConfig.module) {
        webpackConfig.module = {};
      }
      if (!webpackConfig.module.rules) {
        webpackConfig.module.rules = [];
      }
      // loaders in webpack apply bottom->up so ensure
      // ours comes before the default swc transform
      webpackConfig.module.rules.push({
        test: /.*\.(mjs|cjs|cts|ts|tsx|js|jsx)$/,
        loader: loaderPath,
      });

      if (args[1]?.isServer) {
        externalizeWsNativeAccelerators(webpackConfig);
      }

      return existingWebpackModify
        ? (existingWebpackModify(...args) ?? webpackConfig)
        : webpackConfig;
    };
    // only run this in the main process so it only runs once
    // as Next.js uses child processes for different builds
    if (
      !process.env.WORKFLOW_NEXT_PRIVATE_BUILT &&
      phase !== 'phase-production-server'
    ) {
      const workflowBuilder = await getWorkflowBuilder();

      await workflowBuilder.build();
      process.env.WORKFLOW_NEXT_PRIVATE_BUILT = '1';
    }

    return nextConfig;
  };
}
