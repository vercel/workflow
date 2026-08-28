/**
 * Reproduction coverage for vercel/workflow#3859. Step bundles are produced by
 * standalone esbuild, so modules that only the host bundler can understand
 * have to cross the HostModuleResolver boundary as bundle-ready source.
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
import {
  createSwcPlugin,
  type HostModuleResolver,
} from './swc-esbuild-plugin.js';

const realTmpdir = realpathSync(tmpdir());
const resolveExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function writeFile(path: string, contents = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('host-provided modules in step bundles', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-host-module-'));
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

  function createProject({
    dependencyExtension = '.ts',
    dependencyImport = '../db/index',
    dependencySource = "import { env } from 'virtual:env/server';\nexport const url = env.DATABASE_URL;",
  }: {
    dependencyExtension?: string;
    dependencyImport?: string;
    dependencySource?: string;
  } = {}) {
    const stepFile = join(testRoot, 'workflows', 'my-workflow.ts');
    const dependencyFile = join(testRoot, 'db', `index${dependencyExtension}`);
    writeFile(dependencyFile, dependencySource);
    writeFile(
      stepFile,
      `import { url } from '${dependencyImport}';\nexport async function myStep() {\n  'use step';\n  return url;\n}`
    );
    return { dependencyFile, stepFile };
  }

  async function discover(stepFile: string) {
    const state = {
      discoveredSteps: new Set<string>(),
      discoveredWorkflows: new Set<string>(),
      discoveredSerdeFiles: new Set<string>(),
      discoveredFiles: new Set<string>(),
    };
    await fastDiscoverEntries({
      entryPoints: [stepFile],
      state,
      defaultTsconfigPath: undefined,
      workingDir: testRoot,
    });
    return state;
  }

  async function buildStep({
    bundleTransitiveLocalStepDependencies = true,
    hostResolver,
    stepFile,
  }: {
    bundleTransitiveLocalStepDependencies?: boolean;
    hostResolver?: HostModuleResolver;
    stepFile: string;
  }): Promise<esbuild.BuildResult | esbuild.BuildFailure> {
    const outdir = join(testRoot, 'out');
    return await esbuild
      .build({
        entryPoints: [stepFile],
        absWorkingDir: testRoot,
        outdir,
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
        resolveExtensions,
        plugins: [
          createSwcPlugin({
            mode: 'step',
            entriesToBundle: [stepFile],
            outdir,
            bundleTransitiveLocalStepDependencies,
            hostResolver,
          }),
        ],
      })
      .catch((error: esbuild.BuildFailure) => error);
  }

  function errorText(result: esbuild.BuildResult | esbuild.BuildFailure) {
    return result.errors.map((error) => error.text).join('\n');
  }

  function outputText(result: esbuild.BuildResult | esbuild.BuildFailure) {
    return 'outputFiles' in result ? result.outputFiles?.[0]?.text || '' : '';
  }

  it('fails without a host resolver for a host-only module', async () => {
    const { stepFile } = createProject();
    await discover(stepFile);

    const result = await buildStep({ stepFile });

    expect(errorText(result)).toContain(
      'Could not resolve "virtual:env/server"'
    );
  });

  it('inlines bundle-ready source from the host resolver', async () => {
    const { dependencyFile, stepFile } = createProject();
    await discover(stepFile);
    const resolve = vi.fn<HostModuleResolver['resolve']>(async (source) =>
      source === 'virtual:env/server'
        ? {
            id: '\0virtual:env/server',
            external: false,
            code: `export const env = { DATABASE_URL: 'postgres://from-host' };`,
          }
        : null
    );

    const result = await buildStep({ stepFile, hostResolver: { resolve } });

    expect(errorText(result)).toBe('');
    expect(outputText(result)).toContain('postgres://from-host');
    expect(outputText(result)).not.toMatch(
      /from\s+["']virtual:env\/server["']/
    );
    expect(resolve).toHaveBeenCalledWith('virtual:env/server', dependencyFile);
  });

  it('falls back to the host for unresolved path-style imports', async () => {
    const { dependencyFile, stepFile } = createProject({
      dependencySource: `import { env } from './generated';\nexport const url = env.DATABASE_URL;`,
    });
    await discover(stepFile);
    const resolve = vi.fn<HostModuleResolver['resolve']>(async (source) =>
      source === './generated'
        ? {
            id: '\0virtual:generated',
            external: false,
            code: `export const env = { DATABASE_URL: 'postgres://generated' };`,
          }
        : null
    );

    const result = await buildStep({ stepFile, hostResolver: { resolve } });

    expect(errorText(result)).toBe('');
    expect(outputText(result)).toContain('postgres://generated');
    expect(resolve).toHaveBeenCalledWith('./generated', dependencyFile);
  });

  it('bundles transformed nested host files and preserves external imports', async () => {
    const { stepFile } = createProject({
      dependencySource: `export { url } from 'virtual:env/server';`,
    });
    await discover(stepFile);
    const helperFile = join(testRoot, 'host', 'helper.ts');
    const resolve = vi.fn<HostModuleResolver['resolve']>(
      async (source, importer) => {
        if (source === 'virtual:env/server') {
          return {
            id: '\0virtual:env/server',
            external: false,
            code: `export { url } from './helper.ts';`,
          };
        }
        if (source === './helper.ts' && importer === '\0virtual:env/server') {
          return {
            id: helperFile,
            external: false,
            code: `import { basename } from 'node:path';\nexport const url = basename('/host/transformed');`,
          };
        }
        if (source === 'node:path') {
          return { id: 'node:path', external: true };
        }
        return null;
      }
    );

    const result = await buildStep({ stepFile, hostResolver: { resolve } });

    expect(errorText(result)).toBe('');
    expect(outputText(result)).toContain('node:path');
    expect(outputText(result)).toContain('/host/transformed');
  });

  it('preserves host resolution errors', async () => {
    const { stepFile } = createProject();
    await discover(stepFile);
    const hostResolver: HostModuleResolver = {
      async resolve() {
        throw new Error('host transform failed');
      },
    };

    const result = await buildStep({ stepFile, hostResolver });

    expect(errorText(result)).toContain('host transform failed');
  });

  it('does not consult the host for modules that resolve on disk', async () => {
    const { stepFile } = createProject({
      dependencySource: `export const url = 'postgres://from-disk';`,
    });
    await discover(stepFile);
    const resolve = vi.fn<HostModuleResolver['resolve']>(async () => ({
      id: '\0should-not-be-used',
      external: false,
      code: `export const url = 'from-host';`,
    }));

    const result = await buildStep({ stepFile, hostResolver: { resolve } });

    expect(errorText(result)).toBe('');
    expect(outputText(result)).toContain('postgres://from-disk');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps a `.js`-suffixed TypeScript dependency external in production', async () => {
    const { stepFile } = createProject({ dependencyImport: '../db/index.js' });
    await discover(stepFile);

    const result = await buildStep({
      bundleTransitiveLocalStepDependencies: false,
      stepFile,
    });

    expect(errorText(result)).toBe('');
    expect(outputText(result)).toMatch(
      /from\s+["'][^"']*db\/index\.(ts|js)["']/
    );
  });

  it('resolves `.jsx` output specifiers to `.tsx` source consistently', async () => {
    const { dependencyFile, stepFile } = createProject({
      dependencyExtension: '.tsx',
      dependencyImport: '../db/index.jsx',
      dependencySource: `export const url: string = 'tsx-source';`,
    });
    const state = await discover(stepFile);

    const result = await buildStep({
      bundleTransitiveLocalStepDependencies: false,
      stepFile,
    });

    expect(state.discoveredFiles).toContain(dependencyFile);
    expect(errorText(result)).toBe('');
    expect(outputText(result)).toMatch(/from\s+["'][^"']*db\/index\.tsx["']/);
  });

  it('uses the exact JavaScript file in both discovery and bundling', async () => {
    const { dependencyFile, stepFile } = createProject({
      dependencyExtension: '.js',
      dependencyImport: '../db/index.js',
      dependencySource: `export const url = 'javascript-source';`,
    });
    writeFile(
      join(testRoot, 'db', 'index.ts'),
      `export const url = 'typescript-source';`
    );
    const state = await discover(stepFile);

    const result = await buildStep({
      bundleTransitiveLocalStepDependencies: false,
      stepFile,
    });

    expect(state.discoveredFiles).toContain(dependencyFile);
    expect(errorText(result)).toBe('');
    expect(outputText(result)).toContain('db/index.js');
    expect(outputText(result)).not.toContain('db/index.ts');
  });
});
