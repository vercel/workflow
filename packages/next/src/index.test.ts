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
      ]);
      expect(builderConfigs).toHaveLength(1);
      expect(builderConfigs[0]).toMatchObject({
        externalPackages: ['server-only', 'client-only', 'plain-external-a'],
      });

      expect(warnSpy).toHaveBeenCalledOnce();
      const warning = warnSpy.mock.calls[0]?.[0] as string;
      expect(warning).toContain('workflow-auto-remove-a');
      expect(warning).toContain('serverExternalPackages');
      expect(warning).toContain('removed');
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
      ]);
      expect(builderConfigs).toHaveLength(1);
      expect(builderConfigs[0]).toMatchObject({
        externalPackages: ['server-only', 'client-only', 'plain-external-b'],
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
