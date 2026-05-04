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

import { createSwcPlugin } from './swc-esbuild-plugin.js';

const realTmpdir = realpathSync(tmpdir());

function writeFile(path: string, contents = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('createSwcPlugin externalizeNonSteps', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-swc-plugin-'));
    applySwcTransformMock.mockReset();
    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it.each([
    { inputExt: '.ts', outputExt: '.js' },
    { inputExt: '.tsx', outputExt: '.js' },
    { inputExt: '.mts', outputExt: '.mjs' },
    { inputExt: '.cts', outputExt: '.cjs' },
  ])('rewrites externalized $inputExt imports to $outputExt when rewriteTsExtensions is enabled', async ({
    inputExt,
    outputExt,
  }) => {
    const outdir = join(testRoot, 'out');
    const srcDir = join(testRoot, 'src');
    const stepFile = join(srcDir, 'step.ts');

    writeFile(join(srcDir, `dep${inputExt}`), 'export const dep = {};');
    writeFile(stepFile, `import { dep } from './dep';\nconsole.log(dep);`);

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile],
          outdir,
          rewriteTsExtensions: true,
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    expect(output).toContain(`/dep${outputExt}`);
    expect(output).not.toContain(`/dep${inputExt}`);
  });

  it('bundles path-aliased project-local imports inline', async () => {
    // Aliased project-local files must be bundled inline (not externalized
    // as relative paths) because their source on disk may contain further
    // alias imports that Node's ESM loader cannot resolve at runtime.
    // See packages/builders/src/swc-esbuild-plugin.ts for full reasoning.
    const outdir = join(testRoot, 'out');
    const srcDir = join(testRoot, 'src');
    const libDir = join(srcDir, 'lib');
    const stepFile = join(srcDir, 'step.ts');

    writeFile(
      join(libDir, 'config.ts'),
      'export const config = { value: "hello-from-config" };'
    );
    writeFile(
      stepFile,
      `import { config } from '@/lib/config';\nconsole.log(config);`
    );

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      alias: { '@': srcDir },
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile],
          outdir,
          rewriteTsExtensions: true,
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    // The aliased helper should be bundled inline (its content is in the
    // output), not externalized as a relative path or left as a bare alias.
    expect(output).toContain('hello-from-config');
    expect(output).not.toContain('@/lib/config');
    expect(output).not.toMatch(/from\s+["'][^"']*\/lib\/config\.(js|ts)["']/);
  });

  it('bundles transitive aliased imports inside aliased helpers (Mux self-referencing package regression)', async () => {
    // Regression test for https://github.com/muxinc/ai/pull/193.
    //
    // A package self-references its own subpath via tsconfig `paths` (e.g.
    // `@my-pkg/lib/foo` → `src/lib/foo.ts`). A step file imports a helper
    // via the alias, and that helper imports another helper via the alias.
    //
    // Previously the helpers were externalized as relative paths, but their
    // source on disk still contained `import "@my-pkg/lib/..."`. At runtime,
    // Node's ESM loader didn't know about tsconfig paths, fell through to
    // the package's `exports` map, and threw `Package subpath ... is not
    // defined by "exports"`.
    //
    // With the fix, aliased project-local files are bundled inline, so
    // their alias imports are resolved at build time.
    const outdir = join(testRoot, 'out');
    const srcDir = join(testRoot, 'src');
    const libDir = join(srcDir, 'lib');
    const stepFile = join(srcDir, 'step.ts');

    writeFile(
      join(libDir, 'providers.ts'),
      'export const providerName = "anthropic";'
    );
    writeFile(
      join(libDir, 'client-factory.ts'),
      // Helper uses the same alias to reach a sibling — this is the case
      // that broke the Mux build with workflow >= 4.2.0-beta.78.
      `import { providerName } from '@my-pkg/lib/providers';
export const client = { provider: providerName };`
    );
    writeFile(
      stepFile,
      `import { client } from '@my-pkg/lib/client-factory';\nconsole.log(client);`
    );

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      alias: { '@my-pkg': srcDir },
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile],
          outdir,
          rewriteTsExtensions: true,
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    // Both helpers should be bundled inline — no aliased specifiers should
    // leak into the output, where Node's ESM loader would choke on them.
    expect(output).toContain('anthropic');
    expect(output).not.toContain('@my-pkg/lib/providers');
    expect(output).not.toContain('@my-pkg/lib/client-factory');
  });

  it('does not relativize Node.js builtin imports', async () => {
    const outdir = join(testRoot, 'out');
    const srcDir = join(testRoot, 'src');
    const stepFile = join(srcDir, 'step.ts');

    writeFile(
      stepFile,
      `import { createHash } from 'crypto';\nimport { join } from 'node:path';\nconsole.log(createHash, join);`
    );

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile],
          outdir,
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    // Builtins should remain as bare specifiers, not relativized paths
    expect(output).toMatch(/from\s+["']crypto["']/);
    expect(output).toMatch(/from\s+["']node:path["']/);
    expect(output).not.toMatch(/from\s+["']\..*crypto["']/);
    expect(output).not.toMatch(/from\s+["']\..*node:path["']/);
  });

  it('does not externalize aliased imports that resolve into node_modules', async () => {
    const outdir = join(testRoot, 'out');
    const srcDir = join(testRoot, 'src');
    const stepFile = join(srcDir, 'step.ts');
    const nodeModulesDir = join(testRoot, 'node_modules', 'some-pkg');

    writeFile(join(nodeModulesDir, 'index.js'), 'export const pkg = "hello";');
    writeFile(stepFile, `import { pkg } from '@pkg';\nconsole.log(pkg);`);

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      alias: { '@pkg': join(nodeModulesDir, 'index.js') },
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile],
          outdir,
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    // Should be bundled (inlined), not externalized as a relative node_modules path
    expect(output).toContain('hello');
    expect(output).not.toMatch(/from\s+["'].*node_modules/);
  });

  it('externalizes nested bare package imports that only resolve from a bundled package', async () => {
    const outdir = join(testRoot, 'out');
    const srcDir = join(testRoot, 'src');
    const stepFile = join(srcDir, 'step.ts');
    const parentPkgDir = join(testRoot, 'node_modules', 'parent-pkg');
    const parentPkgIndex = join(parentPkgDir, 'index.js');
    const nativePkgDir = join(parentPkgDir, 'node_modules', 'optional-native');

    writeFile(
      join(parentPkgDir, 'package.json'),
      JSON.stringify({ name: 'parent-pkg', main: 'index.js' })
    );
    writeFile(
      parentPkgIndex,
      `const native = require('optional-native');\nexports.value = native.value;`
    );
    writeFile(
      join(nativePkgDir, 'package.json'),
      JSON.stringify({ name: 'optional-native', main: 'binding.node' })
    );
    writeFile(join(nativePkgDir, 'binding.node'), '');
    writeFile(
      stepFile,
      `import { value } from 'parent-pkg';\nconsole.log(value);`
    );

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile, parentPkgIndex],
          outdir,
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    expect(output).toContain('optional-native');
    expect(output).not.toContain('binding.node');
  });

  it.each([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
  ])('preserves externalized %s extensions by default', async (inputExt) => {
    const outdir = join(testRoot, 'out');
    const srcDir = join(testRoot, 'src');
    const stepFile = join(srcDir, 'step.ts');

    writeFile(join(srcDir, `dep${inputExt}`), 'export const dep = {};');
    writeFile(stepFile, `import { dep } from './dep';\nconsole.log(dep);`);

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile],
          outdir,
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    expect(output).toContain(`/dep${inputExt}`);
  });
});

describe('createSwcPlugin sideEffectEntries', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-swc-plugin-'));
    applySwcTransformMock.mockReset();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  /**
   * Helper: creates a fake node_modules package with `"sideEffects": false`
   * in its package.json and a single entry file that exports a side-effectful
   * registration call (simulating what the SWC transform produces).
   */
  function createSideEffectsFalsePackage(
    packageName: string,
    entryCode: string
  ): string {
    const pkgDir = join(testRoot, 'node_modules', packageName);
    writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        sideEffects: false,
        main: 'index.js',
      })
    );
    const entryPath = join(pkgDir, 'index.js');
    writeFile(entryPath, entryCode);
    return entryPath;
  }

  it('preserves bare imports of sideEffectEntries packages when bundling without entriesToBundle', async () => {
    const sideEffectCode =
      'globalThis.__registered = globalThis.__registered || [];\nglobalThis.__registered.push("my-pkg");';
    const entryPath = createSideEffectsFalsePackage(
      'my-side-effect-pkg',
      sideEffectCode
    );

    // SWC mock: return the code unchanged (the side effects are already there)
    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );

    const result = await esbuild.build({
      stdin: {
        contents: `import 'my-side-effect-pkg';`,
        resolveDir: testRoot,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      absWorkingDir: testRoot,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      treeShaking: true,
      logLevel: 'silent',
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          sideEffectEntries: [entryPath],
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    // The registration code should be present in the bundle
    expect(output).toContain('__registered');
  });

  it('drops bare imports when sideEffectEntries is NOT provided for sideEffects:false packages', async () => {
    const sideEffectCode =
      'globalThis.__registered = globalThis.__registered || [];\nglobalThis.__registered.push("my-pkg");';
    createSideEffectsFalsePackage('my-dropped-pkg', sideEffectCode);

    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );

    const result = await esbuild.build({
      stdin: {
        contents: `import 'my-dropped-pkg';`,
        resolveDir: testRoot,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      absWorkingDir: testRoot,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      treeShaking: true,
      logLevel: 'silent',
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    // Without sideEffectEntries, esbuild drops the bare import
    expect(output).not.toContain('__registered');
  });

  it('produces no warnings for sideEffectEntries packages', async () => {
    const sideEffectCode =
      'globalThis.__registered = globalThis.__registered || [];\nglobalThis.__registered.push("warned-pkg");';
    const entryPath = createSideEffectsFalsePackage(
      'my-warned-pkg',
      sideEffectCode
    );

    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );

    const result = await esbuild.build({
      stdin: {
        contents: `import 'my-warned-pkg';`,
        resolveDir: testRoot,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      absWorkingDir: testRoot,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      treeShaking: true,
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          sideEffectEntries: [entryPath],
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    // No "ignored-bare-import" warnings should be produced
    const sideEffectWarnings = result.warnings.filter(
      (w) => w.id === 'ignored-bare-import'
    );
    expect(sideEffectWarnings).toHaveLength(0);
  });

  it('preserves bare imports with entriesToBundle and sideEffectEntries together', async () => {
    const sideEffectCode =
      'globalThis.__registered = globalThis.__registered || [];\nglobalThis.__registered.push("bundled-pkg");';
    const entryPath = createSideEffectsFalsePackage(
      'my-bundled-pkg',
      sideEffectCode
    );

    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );

    const outdir = join(testRoot, 'out');
    const stepFile = join(testRoot, 'src', 'step.ts');
    writeFile(
      stepFile,
      `import 'my-bundled-pkg';\nexport const POST = () => {};`
    );

    const result = await esbuild.build({
      entryPoints: [stepFile],
      absWorkingDir: testRoot,
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      treeShaking: true,
      logLevel: 'silent',
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: [stepFile, entryPath],
          outdir,
          sideEffectEntries: [entryPath],
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    // The registration code should be bundled in
    expect(output).toContain('__registered');
  });

  it('preserves bare imports for local files with sideEffects:false in their parent package.json', async () => {
    // Simulate a workspace package with sideEffects: false
    const pkgDir = join(testRoot, 'packages', 'shared');
    writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@myorg/shared',
        version: '1.0.0',
        sideEffects: false,
        main: 'index.js',
      })
    );
    const sharedEntry = join(pkgDir, 'index.js');
    writeFile(sharedEntry, 'globalThis.__sharedRegistered = true;');

    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );

    // Use a relative import to the local file (like the virtual entry does for local files)
    const result = await esbuild.build({
      stdin: {
        contents: `import './packages/shared/index.js';`,
        resolveDir: testRoot,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      absWorkingDir: testRoot,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      treeShaking: true,
      logLevel: 'silent',
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          sideEffectEntries: [sharedEntry],
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    expect(output).toContain('__sharedRegistered');
  });

  it('does not override sideEffects for non-entry modules', async () => {
    // Create two packages - one is a side-effect entry, one is not
    const sideEffectCode = 'globalThis.__entryRegistered = true;';
    const entryPath = createSideEffectsFalsePackage(
      'entry-pkg',
      sideEffectCode
    );

    const nonEntryCode = 'globalThis.__nonEntryRegistered = true;';
    createSideEffectsFalsePackage('non-entry-pkg', nonEntryCode);

    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );

    const result = await esbuild.build({
      stdin: {
        contents: `import 'entry-pkg';\nimport 'non-entry-pkg';`,
        resolveDir: testRoot,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      absWorkingDir: testRoot,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      treeShaking: true,
      logLevel: 'silent',
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          // Only entry-pkg is listed, non-entry-pkg is not
          sideEffectEntries: [entryPath],
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0].text;
    // entry-pkg should be preserved
    expect(output).toContain('__entryRegistered');
    // non-entry-pkg should be dropped (sideEffects: false is respected)
    expect(output).not.toContain('__nonEntryRegistered');
  });
});

describe('createSwcPlugin projectRoot', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-swc-plugin-'));
    applySwcTransformMock.mockReset();
    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  function setupFixture() {
    const appRoot = join(testRoot, 'apps', 'chat');
    const packageRoot = join(testRoot, 'packages', 'vade');
    const workflowFile = join(
      packageRoot,
      'src',
      'internal',
      'message',
      'workflow',
      'handle-message.ts'
    );

    writeFile(
      workflowFile,
      `export async function handleMessageWorkflow(message) {
  "use workflow";

  return message;
}
`
    );

    return {
      appRoot,
      packageRoot,
      workflowFile,
    };
  }

  it('passes the explicit projectRoot through to applySwcTransform', async () => {
    const fixture = setupFixture();

    const result = await esbuild.build({
      entryPoints: [fixture.workflowFile],
      absWorkingDir: fixture.packageRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          projectRoot: fixture.appRoot,
          workflowManifest: {},
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    expect(applySwcTransformMock).toHaveBeenCalledWith(
      'src/internal/message/workflow/handle-message.ts',
      expect.stringContaining('"use workflow"'),
      'workflow',
      fixture.workflowFile,
      fixture.appRoot
    );
  });

  it('defaults the transform projectRoot to absWorkingDir', async () => {
    const fixture = setupFixture();

    const result = await esbuild.build({
      entryPoints: [fixture.workflowFile],
      absWorkingDir: fixture.packageRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          workflowManifest: {},
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    expect(applySwcTransformMock).toHaveBeenCalledWith(
      'src/internal/message/workflow/handle-message.ts',
      expect.stringContaining('"use workflow"'),
      'workflow',
      fixture.workflowFile,
      fixture.packageRoot
    );
  });
});
