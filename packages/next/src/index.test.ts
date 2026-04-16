import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildMock,
  builderConfigs,
  getNextBuilderMock,
  shouldUseDeferredBuilderMock,
} = vi.hoisted(() => {
  const buildMock = vi.fn(async () => {});
  const builderConfigs: Record<string, unknown>[] = [];
  const getNextBuilderMock = vi.fn(async () => {
    return class MockNextBuilder {
      build = buildMock;

      constructor(config: Record<string, unknown>) {
        builderConfigs.push(config);
      }
    };
  });
  const shouldUseDeferredBuilderMock = vi.fn(() => false);

  return {
    buildMock,
    builderConfigs,
    getNextBuilderMock,
    shouldUseDeferredBuilderMock,
  };
});

vi.mock('./builder.js', () => ({
  getNextBuilder: getNextBuilderMock,
  shouldUseDeferredBuilder: shouldUseDeferredBuilderMock,
  WORKFLOW_DEFERRED_ENTRIES: [
    '/.well-known/workflow/v1/flow',
    '/.well-known/workflow/v1/step',
    '/.well-known/workflow/v1/webhook/[token]',
  ],
}));

import { withWorkflow } from './index.js';

const loaderStubPath = join(
  process.cwd(),
  'packages',
  'next',
  'src',
  'loader.js'
);
const hadLoaderStub = existsSync(loaderStubPath);

describe('withWorkflow outputFileTracingRoot', () => {
  const originalEnv = {
    PORT: process.env.PORT,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    WORKFLOW_LOCAL_DATA_DIR: process.env.WORKFLOW_LOCAL_DATA_DIR,
    WORKFLOW_NEXT_LAZY_DISCOVERY: process.env.WORKFLOW_NEXT_LAZY_DISCOVERY,
    WORKFLOW_NEXT_PRIVATE_BUILT: process.env.WORKFLOW_NEXT_PRIVATE_BUILT,
    WORKFLOW_CONFIGURED_WORLD_PACKAGE:
      process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE,
    WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD,
  };

  beforeEach(() => {
    buildMock.mockClear();
    builderConfigs.length = 0;
    getNextBuilderMock.mockClear();
    shouldUseDeferredBuilderMock.mockClear();

    if (!hadLoaderStub) {
      writeFileSync(loaderStubPath, 'module.exports = {};\n', 'utf-8');
    }

    delete process.env.PORT;
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.WORKFLOW_LOCAL_DATA_DIR;
    delete process.env.WORKFLOW_NEXT_LAZY_DISCOVERY;
    delete process.env.WORKFLOW_NEXT_PRIVATE_BUILT;
    delete process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE;
    delete process.env.WORKFLOW_TARGET_WORLD;
  });

  afterEach(() => {
    if (!hadLoaderStub && existsSync(loaderStubPath)) {
      rmSync(loaderStubPath);
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('uses outputFileTracingRoot as the builder projectRoot when configured', async () => {
    const config = withWorkflow({
      outputFileTracingRoot: '/repo',
    });

    await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(getNextBuilderMock).toHaveBeenCalledOnce();
    expect(buildMock).toHaveBeenCalledOnce();
    expect(builderConfigs).toHaveLength(1);
    expect(builderConfigs[0]).toMatchObject({
      projectRoot: '/repo',
      workingDir: process.cwd(),
    });
  });

  it('preserves an explicit lazyDiscovery disable override', () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = '0';

    withWorkflow(
      {},
      {
        workflows: {
          lazyDiscovery: true,
        },
      }
    );

    expect(process.env.WORKFLOW_NEXT_LAZY_DISCOVERY).toBe('0');
  });

  it('treats an empty lazyDiscovery env override as unset', () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = '';

    withWorkflow(
      {},
      {
        workflows: {
          lazyDiscovery: true,
        },
      }
    );

    expect(process.env.WORKFLOW_NEXT_LAZY_DISCOVERY).toBe('1');
  });

  it('externalizes only the configured local world package by default', async () => {
    const config = withWorkflow({});

    const nextConfig = await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(nextConfig.serverExternalPackages).toEqual([
      '@workflow/world-local',
    ]);
    expect(nextConfig.outputFileTracingIncludes).toMatchObject({
      '/.well-known/workflow/v1/**': ['./packages/world-local/**/*'],
    });
    expect(nextConfig.env?.WORKFLOW_CONFIGURED_WORLD_PACKAGE).toBe(
      '@workflow/world-local'
    );
    expect(process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE).toBe(
      '@workflow/world-local'
    );
    expect(builderConfigs).toHaveLength(1);
    expect(builderConfigs[0]).toMatchObject({
      configuredWorldPackage: '@workflow/world-local',
      externalPackages: ['server-only', 'client-only', '@workflow/world-local'],
    });
    expect(nextConfig.serverExternalPackages).not.toContain('workflow');
    expect(nextConfig.serverExternalPackages).not.toContain('@workflow/core');
  });

  it('externalizes the configured world package root alongside existing externals', async () => {
    process.env.WORKFLOW_TARGET_WORLD = '@workflow/world-postgres/subpath';

    const config = withWorkflow({
      serverExternalPackages: ['sharp'],
    });

    const nextConfig = await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(nextConfig.serverExternalPackages).toEqual([
      'sharp',
      '@workflow/world-postgres',
    ]);
    expect(nextConfig.env?.WORKFLOW_CONFIGURED_WORLD_PACKAGE).toBe(
      '@workflow/world-postgres'
    );
    expect(builderConfigs).toHaveLength(1);
    expect(builderConfigs[0]).toMatchObject({
      configuredWorldPackage: '@workflow/world-postgres',
      externalPackages: [
        'server-only',
        'client-only',
        'sharp',
        '@workflow/world-postgres',
      ],
    });
  });

  it('does not add path-based custom worlds to serverExternalPackages', async () => {
    process.env.WORKFLOW_TARGET_WORLD = './src/world.ts';

    const config = withWorkflow({});

    const nextConfig = await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(nextConfig.serverExternalPackages).toBeUndefined();
    expect(nextConfig.env?.WORKFLOW_CONFIGURED_WORLD_PACKAGE).toBeUndefined();
    expect(process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE).toBeUndefined();
    expect(builderConfigs).toHaveLength(1);
    expect(builderConfigs[0]).toMatchObject({
      configuredWorldPackage: undefined,
      externalPackages: ['server-only', 'client-only'],
    });
  });
});
