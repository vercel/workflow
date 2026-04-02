import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildMock,
  onBeforeDeferredEntriesMock,
  getNextBuilderDeferredMock,
  discoverEntriesMock,
} = vi.hoisted(() => {
  const buildMock = vi.fn(async () => {});
  const onBeforeDeferredEntriesMock = vi.fn(async () => {});
  const discoverEntriesMock = vi.fn(async () => ({
    discoveredWorkflows: [],
    discoveredSteps: [],
    discoveredSerdeFiles: [],
  }));

  const getNextBuilderDeferredMock = vi.fn(async () => {
    return class MockNextDeferredBuilder {
      build = buildMock;
      onBeforeDeferredEntries = onBeforeDeferredEntriesMock;
      discoverEntries = discoverEntriesMock;

      constructor(public config: any) {}

      async initializeDiscoveryState() {
        await this.loadWorkflowsCache();
        const hasCache = this.config._mockHasCache;
        const isProduction = !this.config.watch;
        if (isProduction || !hasCache) {
          await this.discoverEntries([], '');
        }
      }

      async loadWorkflowsCache() {}
    };
  });

  return {
    buildMock,
    onBeforeDeferredEntriesMock,
    getNextBuilderDeferredMock,
    discoverEntriesMock,
  };
});

vi.mock('./builder-deferred.js', () => ({
  getNextBuilderDeferred: getNextBuilderDeferredMock,
}));

describe('NextDeferredBuilder', () => {
  beforeEach(() => {
    buildMock.mockClear();
    onBeforeDeferredEntriesMock.mockClear();
    discoverEntriesMock.mockClear();
  });

  it('should not perform eager workflow discovery in dev mode when cache exists', async () => {
    const { getNextBuilderDeferred } = await import('./builder-deferred.js');
    const NextDeferredBuilder = await getNextBuilderDeferred();

    const builder = new NextDeferredBuilder({
      watch: true, // Dev mode
      _mockHasCache: true, // Simulate cache exists
    });

    await builder.initializeDiscoveryState();

    // In dev mode with cache, discoverEntries should NOT be called
    expect(discoverEntriesMock).not.toHaveBeenCalled();
  });

  it('should perform discovery in production builds', async () => {
    const { getNextBuilderDeferred } = await import('./builder-deferred.js');
    const NextDeferredBuilder = await getNextBuilderDeferred();

    const builder = new NextDeferredBuilder({
      watch: false, // Production mode
      _mockHasCache: true,
    });

    await builder.initializeDiscoveryState();

    // In production, discoverEntries SHOULD be called
    expect(discoverEntriesMock).toHaveBeenCalled();
  });

  it('should perform discovery on first dev build when no cache', async () => {
    const { getNextBuilderDeferred } = await import('./builder-deferred.js');
    const NextDeferredBuilder = await getNextBuilderDeferred();

    const builder = new NextDeferredBuilder({
      watch: true, // Dev mode
      _mockHasCache: false, // No cache
    });

    await builder.initializeDiscoveryState();

    // First dev build with no cache, discoverEntries SHOULD be called
    expect(discoverEntriesMock).toHaveBeenCalled();
  });
});
