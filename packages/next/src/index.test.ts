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

describe('withWorkflow builder config', () => {
  const originalEnv = {
    PORT: process.env.PORT,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    WORKFLOW_LOCAL_DATA_DIR: process.env.WORKFLOW_LOCAL_DATA_DIR,
    WORKFLOW_NEXT_LAZY_DISCOVERY: process.env.WORKFLOW_NEXT_LAZY_DISCOVERY,
    WORKFLOW_NEXT_PRIVATE_BUILT: process.env.WORKFLOW_NEXT_PRIVATE_BUILT,
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

  it('configures diagnostics inside the default Next.js dist dir', async () => {
    const config = withWorkflow({});

    await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(builderConfigs[0]).toMatchObject({
      distDir: '.next',
      diagnosticsDir: '.next/diagnostics',
    });
  });

  it('configures diagnostics inside a custom Next.js dist dir', async () => {
    const config = withWorkflow({
      distDir: 'build-output',
    });

    await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(builderConfigs[0]).toMatchObject({
      distDir: 'build-output',
      diagnosticsDir: 'build-output/diagnostics',
    });
  });
});
