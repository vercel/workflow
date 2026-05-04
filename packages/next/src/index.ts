import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { NextConfig } from 'next';
import semver from 'semver';
import {
  getNextBuilder,
  shouldUseDeferredBuilder,
  WORKFLOW_DEFERRED_ENTRIES,
} from './builder.js';
import { parseEnvironmentFlag } from './environment-flag.js';

const VERCEL_WORLD_PACKAGE = '@workflow/world-vercel';
const VERCEL_WORLD_DEPENDENCY_PACKAGES = [
  '@vercel/queue',
  '@vercel/oidc',
  '@vercel/cli-auth',
  '@napi-rs/keyring',
];
const VERCEL_WORLD_SERVER_EXTERNAL_PACKAGES = [
  VERCEL_WORLD_PACKAGE,
  ...VERCEL_WORLD_DEPENDENCY_PACKAGES,
];

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
      lazyDiscovery?: boolean;
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
  const lazyDiscoveryOverride = parseEnvironmentFlag(
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY
  );
  if (lazyDiscoveryOverride === undefined) {
    if (workflows?.lazyDiscovery) {
      process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = '1';
    }
  } else {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = lazyDiscoveryOverride
      ? '1'
      : '0';
  }

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
    const loaderPath = require.resolve('./loader');
    let runDeferredBuildFromCallback: (() => Promise<void>) | undefined;

    let nextConfig: NextConfig;

    if (typeof nextConfigOrFn === 'function') {
      nextConfig = await nextConfigOrFn(phase, ctx);
    } else {
      nextConfig = nextConfigOrFn;
    }
    // shallow clone to avoid read-only on top-level
    nextConfig = Object.assign({}, nextConfig);
    nextConfig.serverExternalPackages = [
      ...new Set([
        ...(nextConfig.serverExternalPackages || []),
        // Keep the Vercel world and its native-prone dependencies external so
        // local builds do not try to parse @vercel/queue's keyring dependency
        // tree.
        ...VERCEL_WORLD_SERVER_EXTERNAL_PACKAGES,
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

    // configure the loader if turbopack is being used
    if (!nextConfig.turbopack) {
      nextConfig.turbopack = {};
    }
    if (!nextConfig.turbopack.rules) {
      nextConfig.turbopack.rules = {};
    }
    const existingRules = nextConfig.turbopack.rules as any;
    const nextVersion = resolveNextVersion(process.cwd());
    const supportsTurboCondition = semver.gte(nextVersion, 'v16.0.0');
    const useDeferredBuilder = shouldUseDeferredBuilder(nextVersion);

    // Deferred builder discovers files via loader socket notifications, so
    // turbopack content conditions are only needed with the eager builder.
    const shouldApplyTurboCondition =
      supportsTurboCondition && !useDeferredBuilder;
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
            // discover workflows from pages/app entries
            dirs: ['pages', 'app', 'src/pages', 'src/app'],
            projectRoot: nextConfig.outputFileTracingRoot,
            workingDir: process.cwd(),
            distDir,
            diagnosticsDir: `${distDir}/diagnostics`,
            buildTarget: 'next',
            workflowsBundlePath: '', // not used in base
            stepsBundlePath: '', // not used in base
            webhookBundlePath: '', // node used in base
            sourcemap: workflows?.sourcemap,
            suppressCreateWorkflowsBundleLogs: useDeferredBuilder,
            suppressCreateWorkflowsBundleWarnings: useDeferredBuilder,
            suppressCreateWebhookBundleLogs: useDeferredBuilder,
            suppressCreateManifestLogs: useDeferredBuilder,
            externalPackages: [
              // server-only and client-only are pseudo-packages handled by Next.js
              // during its build process. We mark them as external to prevent esbuild
              // from failing when bundling code that imports them.
              // See: https://nextjs.org/docs/app/getting-started/server-and-client-components
              'server-only',
              'client-only',
              ...(nextConfig.serverExternalPackages || []),
            ],
          });
        })();
      }

      return workflowBuilderPromise;
    };

    if (useDeferredBuilder) {
      runDeferredBuildFromCallback = async () => {
        const workflowBuilder = await getWorkflowBuilder();
        if (typeof workflowBuilder.onBeforeDeferredEntries === 'function') {
          await workflowBuilder.onBeforeDeferredEntries();
        }
      };

      const existingExperimental = (nextConfig.experimental ?? {}) as Record<
        string,
        any
      >;
      const existingDeferredEntries = Array.isArray(
        existingExperimental.deferredEntries
      )
        ? existingExperimental.deferredEntries
        : [];
      const existingOnBeforeDeferredEntries =
        typeof existingExperimental.onBeforeDeferredEntries === 'function'
          ? existingExperimental.onBeforeDeferredEntries
          : undefined;

      nextConfig.experimental = {
        ...existingExperimental,

        // biome-ignore lint/suspicious/noTsIgnore: expect-error is wrong as it will work on valid version
        // @ts-ignore this is only available in canary Next.js
        deferredEntries: [
          ...new Set([
            ...existingDeferredEntries,
            ...WORKFLOW_DEFERRED_ENTRIES,
          ]),
        ],
        onBeforeDeferredEntries: async (...args: unknown[]) => {
          if (existingOnBeforeDeferredEntries) {
            await existingOnBeforeDeferredEntries(...args);
          }
          if (runDeferredBuildFromCallback) {
            await runDeferredBuildFromCallback();
          }
        },
      };
    }

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
        ...(shouldApplyTurboCondition
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
