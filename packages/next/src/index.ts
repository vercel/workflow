import type { NextConfig } from 'next';
import semver from 'semver';
import { getNextBuilder } from './builder.js';

/**
 * Default directories to scan for workflows and steps.
 * These are the standard Next.js app directories.
 */
const DEFAULT_WORKFLOW_DIRS = ['pages', 'app', 'src/pages', 'src/app'];

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
        dataDir?: string;
      };
      /**
       * Directories to scan for workflows and steps.
       * If provided, this completely overrides the defaults.
       *
       * @default ['pages', 'app', 'src/pages', 'src/app']
       */
      dirs?: string[];
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
    const loaderPath = require.resolve('./loader');

    let nextConfig: NextConfig;

    if (typeof nextConfigOrFn === 'function') {
      nextConfig = await nextConfigOrFn(phase, ctx);
    } else {
      nextConfig = nextConfigOrFn;
    }
    // shallow clone to avoid read-only on top-level
    nextConfig = Object.assign({}, nextConfig);

    // configure the loader if turbopack is being used
    if (!nextConfig.turbopack) {
      nextConfig.turbopack = {};
    }
    if (!nextConfig.turbopack.rules) {
      nextConfig.turbopack.rules = {};
    }
    const existingRules = nextConfig.turbopack.rules as any;
    const nextVersion = require('next/package.json').version;
    const supportsTurboCondition = semver.gte(nextVersion, 'v16.0.0');

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
      const shouldWatch = process.env.NODE_ENV === 'development';
      const NextBuilder = await getNextBuilder();
      const workflowBuilder = new NextBuilder({
        watch: shouldWatch,
        dirs: workflows?.dirs ?? DEFAULT_WORKFLOW_DIRS,
        workingDir: process.cwd(),
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
          ...(nextConfig.serverExternalPackages || []),
        ],
      });

      await workflowBuilder.build();
      process.env.WORKFLOW_NEXT_PRIVATE_BUILT = '1';
    }

    return nextConfig;
  };
}
