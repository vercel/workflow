import { NextBuilder } from '@workflow/cli/dist/lib/builders/next-build';
import type { NextConfig } from 'next';

export function withWorkflow({
  workflows,
  ...nextConfig
}: NextConfig & {
  workflows?: {
    embedded?: {
      port?: number;
      dataDir?: string;
    };
  };
}) {
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

  const loaderPath = require.resolve('./loader');

  // configure the loader if turbopack is being used
  if (!nextConfig.turbopack) {
    nextConfig.turbopack = {};
  }
  if (!nextConfig.turbopack.rules) {
    nextConfig.turbopack.rules = {};
  }
  const existingRules = nextConfig.turbopack.rules as any;

  nextConfig.turbopack.rules = {
    ...existingRules,
    '*.tsx': {
      loaders: [...(existingRules['*.tsx']?.loaders || []), loaderPath],
    },
    '*.ts': {
      loaders: [...(existingRules['*.ts']?.loaders || []), loaderPath],
    },
    '*.jsx': {
      loaders: [...(existingRules['*.jsx']?.loaders || []), loaderPath],
    },
    '*.js': {
      loaders: [...(existingRules['*.js']?.loaders || []), loaderPath],
    },
  };

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

  return async function buildConfig(phase: string) {
    // only run this in the main process so it only runs once
    // as Next.js uses child processes for different builds
    if (
      !process.env.WORKFLOW_NEXT_PRIVATE_BUILT &&
      phase !== 'phase-production-server'
    ) {
      const shouldWatch = process.env.NODE_ENV === 'development';
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
      process.env.WORKFLOW_NEXT_PRIVATE_BUILT = '1';
    }

    return nextConfig;
  };
}
