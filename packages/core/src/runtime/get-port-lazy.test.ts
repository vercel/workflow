import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPortLazy,
  resetPortCacheForTesting,
  setPortResolverForTesting,
} from './get-port-lazy.js';

describe('getPortLazy port caching', () => {
  beforeEach(() => {
    vi.stubEnv('PORT', '');
  });

  afterEach(() => {
    resetPortCacheForTesting();
    vi.unstubAllEnvs();
  });

  it('resolves the port once and reuses it on subsequent calls', async () => {
    let calls = 0;
    setPortResolverForTesting(async () => {
      calls++;
      return 3000;
    });

    expect(await getPortLazy()).toBe(3000);
    expect(await getPortLazy()).toBe(3000);
    expect(await getPortLazy()).toBe(3000);

    // The expensive OS query (e.g. spawning `lsof`) runs only once.
    expect(calls).toBe(1);
  });

  it('dedupes concurrent first calls into a single resolution', async () => {
    let calls = 0;
    setPortResolverForTesting(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 4000;
    });

    const results = await Promise.all([
      getPortLazy(),
      getPortLazy(),
      getPortLazy(),
    ]);

    expect(results).toEqual([4000, 4000, 4000]);
    expect(calls).toBe(1);
  });

  it('does not cache undefined, and caches the first concrete port', async () => {
    let calls = 0;
    setPortResolverForTesting(async () => {
      calls++;
      // Server not listening yet on the first two calls, then it comes up.
      return calls < 3 ? undefined : 5000;
    });

    // Transient undefined must not poison the cache — each call retries.
    expect(await getPortLazy()).toBeUndefined();
    expect(await getPortLazy()).toBeUndefined();
    // First concrete port resolves and is cached from here on.
    expect(await getPortLazy()).toBe(5000);
    expect(await getPortLazy()).toBe(5000);

    // 3 real queries (the two undefined + the one that resolved); the final
    // call is served from cache.
    expect(calls).toBe(3);
  });
});

// Node reads `NODE_PATH` once at startup into its global lookup paths.
// Package-manager bins (pnpm, npx) set it to a store directory that contains
// every workspace package, which would make `@workflow/utils` resolvable from
// anywhere and hide the strict-layout behavior under test.
const reinitModulePaths = () =>
  (Module as unknown as { _initPaths: () => void })._initPaths();

describe('getPortLazy resolution', () => {
  let root: string;

  beforeEach(() => {
    vi.stubEnv('PORT', '');
    vi.stubEnv('NODE_PATH', '');
    reinitModulePaths();
    resetPortCacheForTesting();
    root = mkdtempSync(join(tmpdir(), 'wf-get-port-'));
  });

  afterEach(() => {
    resetPortCacheForTesting();
    vi.unstubAllEnvs();
    reinitModulePaths();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Lays out a pnpm-style strict tree: the app links `workflow` from a store
   * directory, and `@workflow/utils` is only reachable from that store entry,
   * never from the app root.
   */
  function createStrictLayout(detectedPort: number): string {
    const app = join(root, 'app');
    const store = join(root, 'store');
    const workflowPkg = join(store, 'node_modules', 'workflow');
    const utilsPkg = join(store, 'node_modules', '@workflow', 'utils');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    mkdirSync(workflowPkg, { recursive: true });
    mkdirSync(utilsPkg, { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"app"}');
    writeFileSync(
      join(workflowPkg, 'package.json'),
      '{"name":"workflow","main":"index.js"}'
    );
    writeFileSync(join(workflowPkg, 'index.js'), '');
    writeFileSync(
      join(utilsPkg, 'package.json'),
      JSON.stringify({
        name: '@workflow/utils',
        exports: { './get-port': './get-port.cjs' },
      })
    );
    writeFileSync(
      join(utilsPkg, 'get-port.cjs'),
      `exports.getPort = async () => ${detectedPort};`
    );
    symlinkSync(
      workflowPkg,
      join(app, 'node_modules', 'workflow'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    return app;
  }

  it('finds @workflow/utils through the workflow package when the app does not depend on it', async () => {
    const detectedPort = 4561;
    vi.spyOn(process, 'cwd').mockReturnValue(createStrictLayout(detectedPort));

    expect(await getPortLazy()).toBe(detectedPort);
  });

  it('prefers the PORT environment variable over detection', async () => {
    const detectedPort = 4562;
    const envPort = 4563;
    vi.spyOn(process, 'cwd').mockReturnValue(createStrictLayout(detectedPort));
    vi.stubEnv('PORT', String(envPort));

    expect(await getPortLazy()).toBe(envPort);
  });

  it('ignores an invalid PORT value', async () => {
    const detectedPort = 4564;
    vi.spyOn(process, 'cwd').mockReturnValue(createStrictLayout(detectedPort));
    vi.stubEnv('PORT', 'not-a-port');

    expect(await getPortLazy()).toBe(detectedPort);
  });

  it('returns undefined and warns once when get-port cannot be resolved', async () => {
    const app = join(root, 'empty-app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"empty-app"}');
    vi.spyOn(process, 'cwd').mockReturnValue(app);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warnings = () =>
      warn.mock.calls.filter((args) =>
        String(args[0]).includes('Could not detect the port')
      );

    expect(await getPortLazy()).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(String(warnings()[0][0])).toContain('PORT');

    // The failed loader is cached for the process, so it does not warn again.
    expect(await getPortLazy()).toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });
});
