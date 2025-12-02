import type { NextConfig } from 'next';
import semver from 'semver';
import { getNextBuilder } from './builder.js';

/**
 * Browser workflow configuration.
 */
export interface BrowserWorkflowConfig {
  /**
   * Glob patterns for files containing browser workflows.
   * These files will be transformed with 'browser' mode instead of 'client' mode.
   * @example ['src/workflows/browser/**\/*.ts']
   */
  include: string[];

  /**
   * Path to custom SharedWorker entry file (optional).
   * If not provided, a default worker entry will be generated.
   */
  workerEntry?: string;

  /**
   * OPFS database path for browser storage.
   * @default 'workflows.db'
   */
  database?: string;
}

/**
 * Workflow configuration options.
 */
export interface WorkflowOptions {
  workflows?: {
    embedded?: {
      port?: number;
      dataDir?: string;
    };
  };

  /**
   * Browser workflow configuration.
   * When provided, enables browser-based workflow execution using SharedWorker.
   * Files matching the include patterns will be transformed to call the browser workflow client.
   */
  browser?: BrowserWorkflowConfig;
}

export function withWorkflow(
  nextConfigOrFn:
    | NextConfig
    | ((
        phase: string,
        ctx: { defaultConfig: NextConfig }
      ) => Promise<NextConfig>),
  { workflows, browser }: WorkflowOptions = {}
) {
  if (!process.env.VERCEL_DEPLOYMENT_ID) {
    if (!process.env.WORKFLOW_TARGET_WORLD) {
      process.env.WORKFLOW_TARGET_WORLD = 'embedded';
      process.env.WORKFLOW_EMBEDDED_DATA_DIR = '.next/workflow-data';
    }
    const maybePort = workflows?.embedded?.port;
    if (maybePort) {
      process.env.PORT = maybePort.toString();
    }
  } else {
    if (!process.env.WORKFLOW_TARGET_WORLD) {
      process.env.WORKFLOW_TARGET_WORLD = 'vercel';
    }
  }

  // Store browser workflow config for the loader
  if (browser) {
    process.env.WORKFLOW_BROWSER_INCLUDE = JSON.stringify(browser.include);
    if (browser.workerEntry) {
      process.env.WORKFLOW_BROWSER_WORKER_ENTRY = browser.workerEntry;
    }
    if (browser.database) {
      process.env.WORKFLOW_BROWSER_DATABASE = browser.database;
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

    for (const key of ['*.tsx', '*.ts', '*.jsx', '*.js']) {
      nextConfig.turbopack.rules[key] = {
        ...(supportsTurboCondition
          ? {
              condition: {
                ...existingRules[key]?.condition,
                any: [
                  ...(existingRules[key]?.condition.any || []),
                  {
                    content: /(use workflow|use step)/,
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
        // discover workflows from pages/app entries
        dirs: ['pages', 'app', 'src/pages', 'src/app'],
        workingDir: process.cwd(),
        buildTarget: 'next',
        workflowsBundlePath: '', // not used in base
        stepsBundlePath: '', // not used in base
        webhookBundlePath: '', // node used in base
        externalPackages: [
          ...require('next/dist/lib/server-external-packages.json'),
          ...(nextConfig.serverExternalPackages || []),
        ],
      });

      await workflowBuilder.build();

      // Build browser worker if browser config is provided
      if (browser) {
        const { createBrowserWorkerBuilder } = await import(
          './browser-worker-builder.js'
        );
        // Output to public directory so it's served as a static file
        const browserBuilder = createBrowserWorkerBuilder(
          browser,
          process.cwd(),
          'public'
        );
        await browserBuilder.build();
      }

      process.env.WORKFLOW_NEXT_PRIVATE_BUILT = '1';
    }

    // No rewrites needed - worker is served directly from public folder

    return nextConfig;
  };
}
