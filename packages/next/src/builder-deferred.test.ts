import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on BaseBuilder.discoverEntries to verify when discovery is called
// without mocking the entire implementation
const discoverEntriesSpy = vi.fn();

vi.mock('@workflow/builders', async () => {
  const actual = await vi.importActual('@workflow/builders');
  return {
    ...actual,
    BaseBuilder: class extends (actual as any).BaseBuilder {
      protected async discoverEntries(...args: any[]) {
        discoverEntriesSpy(...args);
        return super.discoverEntries(...args);
      }
    },
  };
});

describe('NextDeferredBuilder conditional discovery', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(process.cwd(), '.test-deferred-builder');
    await mkdir(testDir, { recursive: true });
    discoverEntriesSpy.mockClear();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should skip discovery in dev mode when cache exists', async () => {
    // Create cache directory and cache file
    const cacheDir = join(testDir, '.next', 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'workflows.json'),
      JSON.stringify({
        workflowFiles: [join(testDir, 'workflows/test.ts')],
        stepFiles: [],
      }),
      'utf-8'
    );

    const { getNextBuilderDeferred } = await import('./builder-deferred.js');
    const NextDeferredBuilder = await getNextBuilderDeferred();

    const builder = new NextDeferredBuilder({
      dirs: ['workflows'],
      workingDir: testDir,
      buildTarget: 'next',
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
      distDir: '.next',
      watch: true, // Dev mode
    });

    // @ts-ignore - accessing private method for testing
    await builder.initializeDiscoveryState();

    // In dev mode with cache, discoverEntries should NOT be called
    expect(discoverEntriesSpy).not.toHaveBeenCalled();
  });

  it('should perform discovery in production builds', async () => {
    // Create a workflow file
    const workflowsDir = join(testDir, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
      join(workflowsDir, 'test.ts'),
      '"use workflow";\nexport async function test() {}',
      'utf-8'
    );

    const { getNextBuilderDeferred } = await import('./builder-deferred.js');
    const NextDeferredBuilder = await getNextBuilderDeferred();

    const builder = new NextDeferredBuilder({
      dirs: ['workflows'],
      workingDir: testDir,
      buildTarget: 'next',
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
      distDir: '.next',
      watch: false, // Production mode
    });

    // @ts-ignore - accessing private method for testing
    await builder.initializeDiscoveryState();

    // In production, discoverEntries SHOULD be called
    expect(discoverEntriesSpy).toHaveBeenCalled();
  });

  it('should perform discovery on first dev build when no cache', async () => {
    // Create a workflow file but no cache
    const workflowsDir = join(testDir, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
      join(workflowsDir, 'test.ts'),
      '"use workflow";\nexport async function test() {}',
      'utf-8'
    );

    const { getNextBuilderDeferred } = await import('./builder-deferred.js');
    const NextDeferredBuilder = await getNextBuilderDeferred();

    const builder = new NextDeferredBuilder({
      dirs: ['workflows'],
      workingDir: testDir,
      buildTarget: 'next',
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
      distDir: '.next',
      watch: true, // Dev mode
    });

    // @ts-ignore - accessing private method for testing
    await builder.initializeDiscoveryState();

    // First dev build with no cache, discoverEntries SHOULD be called
    expect(discoverEntriesSpy).toHaveBeenCalled();
  });
});
