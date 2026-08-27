/**
 * Reproduction for vercel/workflow#3859.
 *
 * A step that (transitively) imports a module id only the host bundler can
 * resolve — a Vite virtual module such as `virtual:env/server` from
 * `@vite-env/core` — fails the workflow steps bundle, because that bundle is
 * produced by a standalone esbuild pass with no access to the host bundler's
 * plugin container.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { applySwcTransformMock } = vi.hoisted(() => ({
  applySwcTransformMock: vi.fn(),
}));

vi.mock('./apply-swc-transform.js', () => ({
  applySwcTransform: applySwcTransformMock,
}));

import { importParents } from './discover-entries-esbuild-plugin.js';
import { fastDiscoverEntries } from './fast-discovery.js';
import { createSwcPlugin } from './swc-esbuild-plugin.js';

const realTmpdir = realpathSync(tmpdir());

function writeFile(path: string, contents = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

const RESOLVE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

describe('host-provided (bundler-virtual) module ids in step bundles', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-host-virtual-'));
    importParents.clear();
    applySwcTransformMock.mockReset();
    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );
  });

  afterEach(() => {
    importParents.clear();
    rmSync(testRoot, { recursive: true, force: true });
  });

  /**
   * Mirrors what `BaseBuilder.discoverEntries` does: the real builder walks
   * imports with `fastDiscoverEntries` (a source scan that tolerates
   * unresolvable ids), not with an esbuild pass. Using the esbuild-based
   * discovery plugin here would fail on the virtual id before the bundle step
   * under test ever ran.
   */
  async function discover(stepFile: string): Promise<void> {
    await fastDiscoverEntries({
      entryPoints: [stepFile],
      state: {
        discoveredSteps: new Set<string>(),
        discoveredWorkflows: new Set<string>(),
        discoveredSerdeFiles: new Set<string>(),
        discoveredFiles: new Set<string>(),
      },
      defaultTsconfigPath: undefined,
      workingDir: testRoot,
    });
  }

  /**
   * Without a host resolver there is nothing that can satisfy the id, so the
   * build still fails — that is the pre-fix behaviour, kept as the baseline
   * the resolver-backed case below is measured against.
   */
  it('fails without a host resolver when a local dependency imports a bundler-virtual id', async () => {
    const outdir = join(testRoot, 'out');
    const stepFile = join(testRoot, 'workflows', 'my-workflow.ts');
    const dbFile = join(testRoot, 'db', 'index.ts');

    writeFile(
      dbFile,
      `import { env } from 'virtual:env/server';\nexport const url = env.DATABASE_URL;`
    );
    writeFile(
      stepFile,
      `import { url } from '../db/index';\nexport async function myStep() {\n  'use step';\n  return url;\n}`
    );

    await discover(stepFile);

    const result = await esbuild
      .build({
        entryPoints: [stepFile],
        absWorkingDir: testRoot,
        outdir,
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
        resolveExtensions: [...RESOLVE_EXTENSIONS],
        plugins: [
          createSwcPlugin({
            mode: 'step',
            entriesToBundle: [stepFile],
            outdir,
            bundleTransitiveLocalStepDependencies: true,
          }),
        ],
      })
      .catch((error: esbuild.BuildFailure) => error);

    const errors = 'errors' in result ? result.errors : [];
    expect(errors.map((e) => e.text).join('\n')).toContain(
      'Could not resolve "virtual:env/server"'
    );
  });

  /**
   * Defect 1: the dev path (`bundleTransitiveLocalStepDependencies: true`)
   * inlines project-local files reachable from a step, so a virtual id in that
   * graph is a hard error unless something can provide it. Given a resolver
   * backed by the host bundler's plugin container, the module's source is
   * inlined into the steps bundle instead.
   */
  it('inlines a bundler-virtual dependency through the host resolver', async () => {
    const outdir = join(testRoot, 'out');
    const stepFile = join(testRoot, 'workflows', 'my-workflow.ts');
    const dbFile = join(testRoot, 'db', 'index.ts');

    writeFile(
      dbFile,
      `import { env } from 'virtual:env/server';\nexport const url = env.DATABASE_URL;`
    );
    writeFile(
      stepFile,
      `import { url } from '../db/index';\nexport async function myStep() {\n  'use step';\n  return url;\n}`
    );

    await discover(stepFile);

    const resolveId = vi.fn(async (source: string) =>
      source === 'virtual:env/server' ? '\0virtual:env/server' : null
    );
    const load = vi.fn(async (id: string) =>
      id === '\0virtual:env/server'
        ? `export const env = { DATABASE_URL: 'postgres://from-host' };`
        : null
    );

    const result = await esbuild
      .build({
        entryPoints: [stepFile],
        absWorkingDir: testRoot,
        outdir,
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
        resolveExtensions: [...RESOLVE_EXTENSIONS],
        plugins: [
          createSwcPlugin({
            mode: 'step',
            entriesToBundle: [stepFile],
            outdir,
            bundleTransitiveLocalStepDependencies: true,
            hostResolver: { resolveId, load },
          }),
        ],
      })
      .catch((error: esbuild.BuildFailure) => error);

    const errors = 'errors' in result ? result.errors : [];
    expect(errors.map((e) => e.text).join('\n')).toBe('');
    const output = 'outputFiles' in result ? result.outputFiles![0].text : '';
    expect(output).toContain('postgres://from-host');
    expect(output).not.toMatch(/from\s+["']virtual:env\/server["']/);
    expect(resolveId).toHaveBeenCalledWith('virtual:env/server', dbFile);
  });

  /**
   * The host resolver is a last resort, not an override: a specifier that
   * resolves on disk must never be handed to it.
   */
  it('does not consult the host resolver for specifiers that resolve on disk', async () => {
    const outdir = join(testRoot, 'out');
    const stepFile = join(testRoot, 'workflows', 'my-workflow.ts');
    const helperFile = join(testRoot, 'db', 'index.ts');

    writeFile(helperFile, `export const url = 'postgres://from-disk';`);
    writeFile(
      stepFile,
      `import { url } from '../db/index';\nexport async function myStep() {\n  'use step';\n  return url;\n}`
    );

    await discover(stepFile);

    const resolveId = vi.fn(async () => '\0should-not-be-used');
    const load = vi.fn(async () => `export const url = 'from-host';`);

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
      resolveExtensions: [...RESOLVE_EXTENSIONS],
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile],
          outdir,
          bundleTransitiveLocalStepDependencies: true,
          hostResolver: { resolveId, load },
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.outputFiles[0].text).toContain('postgres://from-disk');
    expect(resolveId).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  /**
   * Defect 2: with the same graph but `bundleTransitiveLocalStepDependencies`
   * off (the production path), the local dependency is supposed to stay
   * external so the host bundler resolves it — and it does, but only when the
   * import specifier is extensionless. A TypeScript NodeNext-style `./x.js`
   * specifier is not resolved by the plugin's enhanced-resolve pass (no
   * `extensionAlias` mapping), so it falls through to esbuild, gets inlined,
   * and fails the production build too.
   */
  it('keeps a `.js`-suffixed local dependency external in the production path', async () => {
    const outdir = join(testRoot, 'out');
    const stepFile = join(testRoot, 'workflows', 'my-workflow.ts');
    const dbFile = join(testRoot, 'db', 'index.ts');

    writeFile(
      dbFile,
      `import { env } from 'virtual:env/server';\nexport const url = env.DATABASE_URL;`
    );
    writeFile(
      stepFile,
      `import { url } from '../db/index.js';\nexport async function myStep() {\n  'use step';\n  return url;\n}`
    );

    await discover(stepFile);

    const result = await esbuild
      .build({
        entryPoints: [stepFile],
        absWorkingDir: testRoot,
        outdir,
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
        resolveExtensions: [...RESOLVE_EXTENSIONS],
        plugins: [
          createSwcPlugin({
            mode: 'step',
            entriesToBundle: [stepFile],
            outdir,
          }),
        ],
      })
      .catch((error: esbuild.BuildFailure) => error);

    // Expected: `db/index` stays external, so the virtual id is never seen
    // here and the host bundler resolves both later.
    const errors = 'errors' in result ? result.errors : [];
    expect(errors).toHaveLength(0);
    const output = 'outputFiles' in result ? result.outputFiles![0].text : '';
    expect(output).toMatch(/from\s+["'][^"']*db\/index\.(ts|js)["']/);
  });
});
