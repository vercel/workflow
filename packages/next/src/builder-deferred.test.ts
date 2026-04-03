import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BuilderWithInit = {
  initializeDiscoveryState: () => Promise<void>;
};

type DiscoverEntriesOwner = {
  discoverEntries: (...args: unknown[]) => Promise<unknown>;
};

type BuilderWithTransitiveSteps = {
  collectTransitiveStepFiles: (args: {
    stepFiles: string[];
    seedFiles?: string[];
  }) => Promise<string[]>;
};

describe('NextDeferredBuilder discovery behavior', () => {
  let testDir: string;
  let discoverEntriesSpy: ReturnType<typeof vi.spyOn>;
  let evalSpy: ReturnType<typeof vi.spyOn>;

  const createBuilder = async (watch: boolean) => {
    const { getNextBuilderDeferred } = await import('./builder-deferred.js');
    const NextDeferredBuilder = await getNextBuilderDeferred();

    return new NextDeferredBuilder({
      dirs: ['app'],
      workingDir: testDir,
      buildTarget: 'next',
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
      distDir: '.next',
      watch,
    });
  };

  const createAppEntrypoint = async () => {
    const appDir = join(testDir, 'app');
    await mkdir(appDir, { recursive: true });
    const workflowFilePath = join(appDir, 'page.ts');
    await writeFile(
      workflowFilePath,
      '"use workflow";\nexport async function test() {}',
      'utf-8'
    );
    return workflowFilePath;
  };

  beforeEach(async () => {
    vi.resetModules();
    testDir = await mkdtemp(join(tmpdir(), 'workflow-deferred-builder-'));

    const { BaseBuilder } = await import('@workflow/builders');
    discoverEntriesSpy = vi.spyOn(
      BaseBuilder.prototype as unknown as DiscoverEntriesOwner,
      'discoverEntries'
    );

    // Vitest executes modules in a VM context where eval('import("...")')
    // requires a dynamic import callback. Forward that specific eval call to
    // native dynamic import so getNextBuilderDeferred can run in tests.
    evalSpy = vi.spyOn(globalThis, 'eval').mockImplementation((source) => {
      if (source === 'import("@workflow/builders")') {
        return import('@workflow/builders');
      }
      throw new Error(`Unexpected eval source in test: ${source}`);
    });
  });

  afterEach(async () => {
    discoverEntriesSpy.mockRestore();
    evalSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
  });

  it('should skip discovery in dev mode when cache exists', async () => {
    const cachedWorkflowFilePath = await createAppEntrypoint();

    // Create cache directory and cache file
    const cacheDir = join(testDir, '.next', 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'workflows.json'),
      JSON.stringify({
        workflowFiles: [cachedWorkflowFilePath],
        stepFiles: [],
      }),
      'utf-8'
    );

    const builder = await createBuilder(true);
    await (builder as unknown as BuilderWithInit).initializeDiscoveryState();

    // In dev mode with cache, discoverEntries should NOT be called
    expect(discoverEntriesSpy).not.toHaveBeenCalled();
  });

  it('should skip discovery in production builds', async () => {
    await createAppEntrypoint();
    const builder = await createBuilder(false);
    await (builder as unknown as BuilderWithInit).initializeDiscoveryState();

    expect(discoverEntriesSpy).not.toHaveBeenCalled();
  });

  it('should skip discovery on first dev build when no cache', async () => {
    await createAppEntrypoint();
    const builder = await createBuilder(true);
    await (builder as unknown as BuilderWithInit).initializeDiscoveryState();

    expect(discoverEntriesSpy).not.toHaveBeenCalled();
  });

  it('should collect transitive @workflow package step files from workflow imports', async () => {
    const appDir = join(testDir, 'app');
    const workflowFilePath = join(appDir, 'page.ts');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      workflowFilePath,
      [
        '"use workflow";',
        "import { closeStream } from '@workflow/ai/agent';",
        'export async function workflowEntry() {',
        '  return closeStream();',
        '}',
      ].join('\n'),
      'utf-8'
    );

    const workflowAiPackageDir = join(testDir, 'node_modules/@workflow/ai');
    await mkdir(workflowAiPackageDir, { recursive: true });
    await writeFile(
      join(workflowAiPackageDir, 'package.json'),
      JSON.stringify({ name: '@workflow/ai', version: '0.0.0' }),
      'utf-8'
    );
    await writeFile(
      join(workflowAiPackageDir, 'agent.js'),
      [
        "import { nestedStep } from './nested.js';",
        'export async function closeStream() {',
        "  'use step';",
        '  return nestedStep();',
        '}',
      ].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(workflowAiPackageDir, 'nested.js'),
      [
        'export async function nestedStep() {',
        "  'use step';",
        "  return 'ok';",
        '}',
      ].join('\n'),
      'utf-8'
    );

    const builder = await createBuilder(true);
    const transitiveStepFiles = await (
      builder as unknown as BuilderWithTransitiveSteps
    ).collectTransitiveStepFiles({
      stepFiles: [],
      seedFiles: [workflowFilePath],
    });

    const normalizedStepFiles = transitiveStepFiles.map((filePath) =>
      filePath.replace(/\\/g, '/')
    );
    expect(
      normalizedStepFiles.some((filePath) =>
        filePath.includes('/node_modules/@workflow/ai/agent')
      )
    ).toBe(true);
    expect(
      normalizedStepFiles.some((filePath) =>
        filePath.includes('/node_modules/@workflow/ai/nested.js')
      )
    ).toBe(true);
  });
});
