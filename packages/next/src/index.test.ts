import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildMock,
  builderConfigs,
  getNextBuilderMock,
  prewarmWorkflowSwcPluginCacheMock,
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
  const prewarmWorkflowSwcPluginCacheMock = vi.fn();

  return {
    buildMock,
    builderConfigs,
    getNextBuilderMock,
    prewarmWorkflowSwcPluginCacheMock,
  };
});

vi.mock('./builder.js', () => ({
  getNextBuilder: getNextBuilderMock,
}));

vi.mock('./swc-plugin-cache.js', () => ({
  prewarmWorkflowSwcPluginCache: prewarmWorkflowSwcPluginCacheMock,
}));

import { withWorkflow } from './index.js';

const loaderStubPath = join(__dirname, 'loader.js');
const hadLoaderStub = existsSync(loaderStubPath);
const realTmpDir = realpathSync(tmpdir());

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('withWorkflow builder config', () => {
  const originalCwd = process.cwd();
  const originalEnv = {
    PORT: process.env.PORT,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    WORKFLOW_LOCAL_DATA_DIR: process.env.WORKFLOW_LOCAL_DATA_DIR,
    WORKFLOW_NEXT_PRIVATE_BUILT: process.env.WORKFLOW_NEXT_PRIVATE_BUILT,
    WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD,
  };

  beforeEach(() => {
    buildMock.mockClear();
    builderConfigs.length = 0;
    getNextBuilderMock.mockClear();
    prewarmWorkflowSwcPluginCacheMock.mockClear();

    if (!hadLoaderStub) {
      writeFileSync(loaderStubPath, 'module.exports = {};\n', 'utf-8');
    }

    delete process.env.PORT;
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.WORKFLOW_LOCAL_DATA_DIR;
    delete process.env.WORKFLOW_NEXT_PRIVATE_BUILT;
    delete process.env.WORKFLOW_TARGET_WORLD;
  });

  afterEach(() => {
    if (!hadLoaderStub && existsSync(loaderStubPath)) {
      rmSync(loaderStubPath);
    }

    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('uses outputFileTracingRoot for tracing without changing module specifier root', async () => {
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
      moduleSpecifierRoot: process.cwd(),
      workingDir: process.cwd(),
    });
  });

  it.each([
    'phase-production-build',
    'phase-development-server',
  ])('prewarms the SWC plugin cache during %s', async (phase) => {
    const config = withWorkflow({});

    await config(phase, { defaultConfig: {} });

    expect(prewarmWorkflowSwcPluginCacheMock).toHaveBeenCalledOnce();
    expect(prewarmWorkflowSwcPluginCacheMock).toHaveBeenCalledWith(
      process.cwd()
    );
  });

  it('does not prewarm the SWC plugin cache for the production server', async () => {
    const config = withWorkflow({});

    await config('phase-production-server', { defaultConfig: {} });

    expect(prewarmWorkflowSwcPluginCacheMock).not.toHaveBeenCalled();
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

  it('externalizes the built-in Vercel world while preserving user externals', async () => {
    const config = withWorkflow({
      serverExternalPackages: ['@node-rs/xxhash'],
    });

    const nextConfig = await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(nextConfig.serverExternalPackages).toEqual([
      '@node-rs/xxhash',
      '@workflow/world-vercel',
      '@vercel/queue',
      '@vercel/oidc',
      '@vercel/cli-auth',
      '@napi-rs/keyring',
    ]);
    expect(nextConfig.outputFileTracingIncludes).toBeUndefined();
  });

  it('preserves user webpack externals without adding Vercel world dependency externals', async () => {
    const userWebpack = vi.fn((webpackConfig: any) => {
      webpackConfig.externals = [{ react: 'commonjs react' }];
      return webpackConfig;
    });
    const config = withWorkflow({
      webpack: userWebpack,
    });

    const nextConfig = await config('phase-production-build', {
      defaultConfig: {},
    });
    const webpackConfig = nextConfig.webpack?.(
      {
        externals: [],
        module: {
          rules: [],
        },
      },
      {} as any
    );

    expect(userWebpack).toHaveBeenCalledOnce();
    expect(webpackConfig?.externals).toEqual([{ react: 'commonjs react' }]);
  });

  it('removes workflow packages from serverExternalPackages for this build', async () => {
    const projectDir = mkdtempSync(
      join(realTmpDir, 'workflow-next-server-external-')
    );
    process.chdir(projectDir);

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');
    writeFile(
      join(
        projectDir,
        'node_modules',
        'workflow-auto-remove-a',
        'package.json'
      ),
      JSON.stringify({
        name: 'workflow-auto-remove-a',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'workflow-auto-remove-a', 'index.js'),
      `export async function runJob() {
  "use workflow";
  return "ok";
}`
    );

    writeFile(
      join(projectDir, 'node_modules', 'plain-external-a', 'package.json'),
      JSON.stringify({
        name: 'plain-external-a',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'plain-external-a', 'index.js'),
      'export const plain = true;'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = withWorkflow({
        serverExternalPackages: ['workflow-auto-remove-a', 'plain-external-a'],
      });

      const resolvedConfig = await config('phase-production-build', {
        defaultConfig: {},
      });

      expect(resolvedConfig.serverExternalPackages).toEqual([
        'plain-external-a',
        '@workflow/world-vercel',
        '@vercel/queue',
        '@vercel/oidc',
        '@vercel/cli-auth',
        '@napi-rs/keyring',
      ]);
      expect(builderConfigs).toHaveLength(1);
      expect(builderConfigs[0]).toMatchObject({
        externalPackages: [
          'server-only',
          'client-only',
          'plain-external-a',
          '@workflow/world-vercel',
          '@vercel/queue',
          '@vercel/oidc',
          '@vercel/cli-auth',
          '@napi-rs/keyring',
        ],
      });

      expect(warnSpy).toHaveBeenCalledOnce();
      const warning = warnSpy.mock.calls[0]?.[0] as string;
      expect(warning).toContain('workflow-auto-remove-a');
      expect(warning).toContain('serverExternalPackages');
      expect(warning).toContain('removed');
      expect(warning).toContain('compiling the packages anyway');
    } finally {
      warnSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps plain serverExternalPackages unchanged', async () => {
    const projectDir = mkdtempSync(
      join(realTmpDir, 'workflow-next-server-external-')
    );
    process.chdir(projectDir);

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');
    writeFile(
      join(projectDir, 'node_modules', 'plain-external-b', 'package.json'),
      JSON.stringify({
        name: 'plain-external-b',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'plain-external-b', 'index.js'),
      'export const plain = true;'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = withWorkflow({
        serverExternalPackages: ['plain-external-b'],
      });

      const resolvedConfig = await config('phase-production-build', {
        defaultConfig: {},
      });

      expect(resolvedConfig.serverExternalPackages).toEqual([
        'plain-external-b',
        '@workflow/world-vercel',
        '@vercel/queue',
        '@vercel/oidc',
        '@vercel/cli-auth',
        '@napi-rs/keyring',
      ]);
      expect(builderConfigs).toHaveLength(1);
      expect(builderConfigs[0]).toMatchObject({
        externalPackages: [
          'server-only',
          'client-only',
          'plain-external-b',
          '@workflow/world-vercel',
          '@vercel/queue',
          '@vercel/oidc',
          '@vercel/cli-auth',
          '@napi-rs/keyring',
        ],
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
