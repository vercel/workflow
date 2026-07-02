import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { NextConfig } from 'next';
import semver from 'semver';
import { getNextBuilder } from './builder.js';

const useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m;
const useStepPattern = /^\s*(['"])use step\1;?\s*$/m;
const workflowSerdeImportPattern = /from\s+(['"])@workflow\/serde\1/;
const workflowSerdeSymbolPattern =
  /Symbol\.for\s*\(\s*(['"])workflow-(?:serialize|deserialize)\1\s*\)/;
const workflowSerdeComputedPropertyPattern =
  /\[\s*WORKFLOW_(?:SERIALIZE|DESERIALIZE)\s*\]/;
const generatedWorkflowPathPattern = /[/\\]\.well-known[/\\]workflow[/\\]/;
const turbopackWorkflowContentPattern =
  /(use workflow|use step|from\s+(['"])@workflow\/serde\2|Symbol\.for\s*\(\s*(['"])workflow-(?:serialize|deserialize)\3\s*\))/;

const PSEUDO_EXTERNAL_PACKAGES = new Set(['server-only', 'client-only']);
const warnedAutoRemovedServerExternalPackages = new Set<string>();

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
  const fallbackVersion = require('next/package.json').version as string;

  try {
    const packageJsonPath = require.resolve('next/package.json', {
      paths: [workingDir],
    });
    const resolvedPackageJson = require(packageJsonPath) as {
      version?: unknown;
    };
    return typeof resolvedPackageJson.version === 'string'
      ? resolvedPackageJson.version
      : fallbackVersion;
  } catch {
    return fallbackVersion;
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findRootFile(names: string[], workingDir: string): string | undefined {
  let current = resolve(workingDir);

  while (true) {
    for (const name of names) {
      const file = join(current, name);
      if (fileExists(file)) {
        return file;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function findNextRootFile(workingDir: string): string | undefined {
  return (
    findRootFile(['pnpm-workspace.yaml'], workingDir) ??
    findRootFile(
      [
        'pnpm-lock.yaml',
        'package-lock.json',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
      ],
      workingDir
    )
  );
}

function resolveNextProjectRoot(
  nextConfig: NextConfig,
  workingDir: string
): string {
  const configuredRoot =
    nextConfig.outputFileTracingRoot ?? nextConfig.turbopack?.root;

  if (configuredRoot) {
    return isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(workingDir, configuredRoot);
  }

  let rootFile = findNextRootFile(workingDir);
  if (!rootFile) {
    return workingDir;
  }

  while (true) {
    const currentDir = dirname(rootFile);
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return currentDir;
    }

    const parentRootFile = findNextRootFile(parentDir);
    if (!parentRootFile) {
      return currentDir;
    }
    rootFile = parentRootFile;
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
    const projectRoot = resolveNextProjectRoot(nextConfig, workingDir);
    const supportsTurboCondition = semver.gte(nextVersion, 'v16.0.0');

    const shouldWatch = process.env.NODE_ENV === 'development';
    let workflowBuilderPromise: Promise<any> | undefined;

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
            distDir: nextConfig.distDir || '.next',
            buildTarget: 'next',
            workflowsBundlePath: '', // not used in base
            stepsBundlePath: '', // not used in base
            webhookBundlePath: '', // node used in base
            externalPackages: [
              // server-only and client-only are pseudo-packages handled by Next.js
              // during its build process. We mark them as external to prevent esbuild
              // from failing when bundling code that imports them.
              // See: https://nextjs.org/docs/app/getting-started/server-and-client-components
              'server-only',
              'client-only',
              ...effectiveServerExternalPackages,
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
                // Merge with any existing 'all' conditions from user config.
                all: [
                  ...(existingRules[key]?.condition?.all || []),
                  // Exclude generated workflow route files from transformation
                  { not: { path: generatedWorkflowPathPattern } },
                  // Match files with workflow directives or custom serialization patterns
                  // Uses backreferences (\2, \3) to ensure matching quote types
                  { content: turbopackWorkflowContentPattern },
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
