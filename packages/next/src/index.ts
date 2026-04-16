import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import type { NextConfig } from 'next';
import semver from 'semver';
import { parseEnvironmentFlag } from './environment-flag.js';
import {
  getNextBuilder,
  shouldUseDeferredBuilder,
  WORKFLOW_DEFERRED_ENTRIES,
} from './builder.js';

function isPathLikeWorldTarget(targetWorld: string): boolean {
  return (
    targetWorld.startsWith('./') ||
    targetWorld.startsWith('../') ||
    targetWorld.startsWith('/') ||
    targetWorld.startsWith('file:') ||
    /^[A-Za-z]:[\\/]/.test(targetWorld) ||
    targetWorld.startsWith('\\\\')
  );
}

function resolvePackageName(specifier: string): string | undefined {
  if (!specifier || isPathLikeWorldTarget(specifier)) {
    return undefined;
  }

  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return scope && name ? `${scope}/${name}` : undefined;
  }

  const [name] = specifier.split('/');
  return name || undefined;
}

function resolveConfiguredWorldExternalPackage(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const targetWorld =
    env.WORKFLOW_TARGET_WORLD ??
    (env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local');

  if (targetWorld === 'vercel') {
    return '@workflow/world-vercel';
  }

  if (targetWorld === 'local' || targetWorld === '@workflow/world-local') {
    return '@workflow/world-local';
  }

  return resolvePackageName(targetWorld);
}

function toTracingGlob(rootDir: string, targetDir: string): string {
  let relativePath = relative(rootDir, targetDir).replace(/\\/g, '/');

  if (!relativePath) {
    return './**/*';
  }

  if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
    relativePath = `./${relativePath}`;
  }

  return `${relativePath}/**/*`;
}

function findPackageRoot(startPath: string): string | undefined {
  let currentPath = startPath;

  while (true) {
    if (existsSync(join(currentPath, 'package.json'))) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

function resolveConfiguredWorldTraceIncludes(
  configuredWorldPackage: string | undefined,
  workingDir: string,
  outputFileTracingRoot?: string
): string[] | undefined {
  if (!configuredWorldPackage) {
    return undefined;
  }

  try {
    const resolvedWorkingDir = realpathSync(workingDir);
    const tracingRoot = realpathSync(
      outputFileTracingRoot ?? resolvedWorkingDir
    );
    const appRequire = createRequire(join(resolvedWorkingDir, 'package.json'));

    try {
      const worldEntryPath = realpathSync(
        appRequire.resolve(configuredWorldPackage)
      );
      const worldPackageRoot = findPackageRoot(dirname(worldEntryPath));
      return worldPackageRoot
        ? [toTracingGlob(tracingRoot, worldPackageRoot)]
        : undefined;
    } catch {
      const workflowRuntimePath = realpathSync(
        appRequire.resolve('workflow/runtime')
      );
      const workflowRequire = createRequire(workflowRuntimePath);
      const coreRuntimePath = realpathSync(
        workflowRequire.resolve('@workflow/core/runtime')
      );
      const coreRequire = createRequire(coreRuntimePath);
      const worldEntryPath = realpathSync(
        coreRequire.resolve(configuredWorldPackage)
      );
      const worldPackageRoot = findPackageRoot(dirname(worldEntryPath));
      return worldPackageRoot
        ? [toTracingGlob(tracingRoot, worldPackageRoot)]
        : undefined;
    }
  } catch {
    try {
      const tracingRoot = realpathSync(outputFileTracingRoot ?? workingDir);
      const coreRuntimePath = realpathSync(
        require.resolve('@workflow/core/runtime')
      );
      const coreRequire = createRequire(coreRuntimePath);
      const worldEntryPath = realpathSync(
        coreRequire.resolve(configuredWorldPackage)
      );
      const worldPackageRoot = findPackageRoot(dirname(worldEntryPath));
      return worldPackageRoot
        ? [toTracingGlob(tracingRoot, worldPackageRoot)]
        : undefined;
    } catch {
      return undefined;
    }
  }
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

  const configuredWorldExternalPackage = resolveConfiguredWorldExternalPackage(
    process.env
  );
  if (configuredWorldExternalPackage) {
    process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE =
      configuredWorldExternalPackage;
  } else {
    delete process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE;
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

    const serverExternalPackages = new Set(
      Array.isArray(nextConfig.serverExternalPackages)
        ? nextConfig.serverExternalPackages
        : []
    );
    if (configuredWorldExternalPackage) {
      serverExternalPackages.add(configuredWorldExternalPackage);
    }
    if (serverExternalPackages.size > 0) {
      nextConfig.serverExternalPackages = [...serverExternalPackages];
    }

    const configuredWorldTraceIncludes = resolveConfiguredWorldTraceIncludes(
      configuredWorldExternalPackage,
      process.cwd(),
      nextConfig.outputFileTracingRoot
    );
    if (configuredWorldTraceIncludes?.length) {
      const routePattern = '/.well-known/workflow/v1/**';
      const outputFileTracingIncludes = {
        ...(nextConfig.outputFileTracingIncludes as
          | Record<string, string[]>
          | undefined),
      };
      outputFileTracingIncludes[routePattern] = [
        ...new Set([
          ...(outputFileTracingIncludes[routePattern] || []),
          ...configuredWorldTraceIncludes,
        ]),
      ];
      nextConfig.outputFileTracingIncludes = outputFileTracingIncludes;
    }

    const nextEnv = {
      ...nextConfig.env,
    } as Record<string, string>;
    if (configuredWorldExternalPackage) {
      nextEnv.WORKFLOW_CONFIGURED_WORLD_PACKAGE =
        configuredWorldExternalPackage;
    } else {
      delete nextEnv.WORKFLOW_CONFIGURED_WORLD_PACKAGE;
    }
    if (Object.keys(nextEnv).length > 0) {
      nextConfig.env = nextEnv;
    } else {
      delete nextConfig.env;
    }

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
            distDir: nextConfig.distDir || '.next',
            buildTarget: 'next',
            workflowsBundlePath: '', // not used in base
            stepsBundlePath: '', // not used in base
            webhookBundlePath: '', // node used in base
            suppressCreateWorkflowsBundleLogs: useDeferredBuilder,
            suppressCreateWorkflowsBundleWarnings: useDeferredBuilder,
            suppressCreateWebhookBundleLogs: useDeferredBuilder,
            suppressCreateManifestLogs: useDeferredBuilder,
            configuredWorldPackage: configuredWorldExternalPackage,
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
        ? existingWebpackModify(...args)
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
