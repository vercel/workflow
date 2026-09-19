import type * as esbuild from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOW_UNSAFE_FLOW_BUNDLE_ENV,
  analyzeFlowBundleSafety,
  assertFlowBundleIsSandboxSafe,
  collectExternalImports,
  findDynamicRequireCandidates,
  maskNonCodeRegions,
} from './flow-bundle-safety.js';

describe('maskNonCodeRegions', () => {
  it('preserves offsets and line breaks', () => {
    const code = [
      'const a = "str";',
      '// comment',
      '/* block',
      ' */ const b;',
    ].join('\n');
    const { masked } = maskNonCodeRegions(code);
    expect(masked).toHaveLength(code.length);
    expect(masked.split('\n')).toHaveLength(code.split('\n').length);
    expect(masked).not.toContain('str');
    expect(masked).not.toContain('comment');
    expect(masked).toContain('const b;');
  });

  it('blanks strings, comments and regexes but keeps template substitutions', () => {
    const code = 'const x = `a require b ${require("fs")} c`;';
    const { masked } = maskNonCodeRegions(code);
    // The literal chunks are blanked...
    expect(masked).not.toContain('a require b');
    // ...but the substitution is real code and must survive.
    expect(masked).toContain('require(');
  });

  it('does not treat division as a regex literal', () => {
    const code = 'const ratio = total / count; const other = require;';
    const { masked } = maskNonCodeRegions(code);
    expect(masked).toBe(code);
  });

  it('blanks regex literals that contain quotes', () => {
    const code = `const re = /require("x")/g; const y = 1;`;
    const { masked } = maskNonCodeRegions(code);
    expect(masked).not.toContain('require');
    expect(masked).toContain('const y = 1;');
  });

  it('records column-zero banner comments', () => {
    const code = [
      '// node_modules/pkg/index.js',
      'var a = 1;',
      '  // indented',
    ].join('\n');
    const { banners } = maskNonCodeRegions(code);
    expect(banners.map((banner) => banner.text)).toEqual([
      'node_modules/pkg/index.js',
    ]);
  });
});

describe('findDynamicRequireCandidates', () => {
  it('ignores esbuild helper wrappers and feature probes', () => {
    const code = [
      'var __commonJS = (cb, mod) => function __require() { return mod; };',
      'var require_inner = __commonJS({ "inner.js"(exports) {} });',
      'var inner = require_inner();',
      'var probe = typeof require === "function";',
      'var other = typeof require !== "undefined" ? 1 : 2;',
      'module.exports.require = 1;',
      'var cfg = { require: true };',
      'loader.require("x");',
    ].join('\n');
    expect(findDynamicRequireCandidates(code)).toEqual([]);
  });

  it('ignores require mentions inside comments and strings', () => {
    const code = [
      '// we used to require("node:fs") here',
      '/* require("node:path") */',
      'var message = "call require(name) at runtime";',
    ].join('\n');
    expect(findDynamicRequireCandidates(code)).toEqual([]);
  });

  it('finds literal and dynamic require calls with locations', () => {
    const code = [
      '// node_modules/pkg/index.js',
      'var fs = require("node:fs");',
      'function lazy(name) { return require(name); }',
    ].join('\n');
    const found = findDynamicRequireCandidates(
      code,
      new Set(['node_modules/pkg/index.js'])
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      module: 'node_modules/pkg/index.js',
      line: 2,
      specifier: 'node:fs',
    });
    expect(found[1]).toMatchObject({
      module: 'node_modules/pkg/index.js',
      line: 3,
      specifier: undefined,
    });
    expect(found[1].snippet).toContain('require(name)');
  });

  it('only attributes modules esbuild actually emitted', () => {
    const code = [
      '// not a module banner',
      'var fs = require("node:fs");',
    ].join('\n');
    const [violation] = findDynamicRequireCandidates(
      code,
      new Set(['real.js'])
    );
    expect(violation.module).toBeUndefined();
  });
});

function metafileWith(
  inputs: esbuild.Metafile['inputs'],
  outputImports: esbuild.Metafile['outputs'][string]['imports'],
  entryPoint = 'virtual-entry.js'
): esbuild.Metafile {
  return {
    inputs,
    outputs: {
      'stdin.js': {
        imports: outputImports,
        exports: [],
        entryPoint,
        inputs: {},
        bytes: 0,
      },
    },
  };
}

describe('collectExternalImports', () => {
  const metafile = metafileWith(
    {
      'virtual-entry.js': {
        bytes: 0,
        format: 'esm',
        imports: [{ path: 'workflow.ts', kind: 'import-statement' }],
      },
      'workflow.ts': {
        bytes: 0,
        format: 'esm',
        imports: [
          {
            path: 'node_modules/wrapper/index.js',
            kind: 'import-statement',
            original: 'wrapper',
          },
        ],
      },
      'node_modules/wrapper/index.js': {
        bytes: 0,
        format: 'cjs',
        imports: [
          {
            path: 'node_modules/leaky/index.js',
            kind: 'require-call',
            original: 'leaky',
          },
        ],
      },
      'node_modules/leaky/index.js': {
        bytes: 0,
        format: 'cjs',
        imports: [{ path: 'node:fs', kind: 'require-call', external: true }],
      },
    },
    [{ path: 'node:fs', kind: 'require-call', external: true }]
  );

  it('reports the importer and the chain back to user code', () => {
    const [violation] = collectExternalImports(metafile);
    expect(violation).toMatchObject({
      specifier: 'node:fs',
      importers: ['node_modules/leaky/index.js'],
      isRuntimeBuiltin: true,
    });
    // The synthetic virtual entry is dropped; user code leads the chain.
    expect(violation.importChain).toEqual([
      'workflow.ts',
      'node_modules/wrapper/index.js',
      'node_modules/leaky/index.js',
    ]);
  });

  it('ignores synthetic esbuild inputs such as <runtime>', () => {
    const synthetic = metafileWith(
      {
        'virtual-entry.js': {
          bytes: 0,
          format: 'esm',
          imports: [
            { path: '<runtime>', kind: 'import-statement', external: true },
          ],
        },
      },
      [{ path: '<runtime>', kind: 'import-statement', external: true }]
    );
    expect(collectExternalImports(synthetic)).toEqual([]);
  });

  it('flags non-builtin externals too', () => {
    const external = metafileWith(
      {
        'virtual-entry.js': {
          bytes: 0,
          format: 'esm',
          imports: [
            { path: 'some-pkg', kind: 'import-statement', external: true },
          ],
        },
      },
      [{ path: 'some-pkg', kind: 'require-call', external: true }]
    );
    const [violation] = collectExternalImports(external);
    expect(violation).toMatchObject({
      specifier: 'some-pkg',
      isRuntimeBuiltin: false,
    });
  });
});

describe('analyzeFlowBundleSafety', () => {
  it('passes a clean bundle', async () => {
    const report = await analyzeFlowBundleSafety({
      bundleText: [
        'var __commonJS = (cb, mod) => function __require() { return mod; };',
        'var require_inner = __commonJS({ "inner.js"(exports) { exports.a = 1; } });',
        'var inner = require_inner();',
        'var hasRequire = typeof require !== "undefined";',
      ].join('\n'),
      metafile: metafileWith(
        {
          'virtual-entry.js': { bytes: 0, format: 'esm', imports: [] },
        },
        []
      ),
    });
    expect(report.externalImports).toEqual([]);
    expect(report.dynamicRequires).toEqual([]);
  });

  it('does not report a shadowed require binding', async () => {
    // esbuild renames shadowed bindings in bundle output, but a hand-written
    // scan cannot rely on that, so the scope-aware probe has the last word.
    const report = await analyzeFlowBundleSafety({
      bundleText: [
        'function umd(factory) {',
        '  factory(function require(id) { return {}; }, {});',
        '}',
        'umd(function (require, exports) { exports.fs = require("node:fs"); });',
      ].join('\n'),
    });
    expect(report.dynamicRequires).toEqual([]);
  });

  it('reports a free dynamic require', async () => {
    const report = await analyzeFlowBundleSafety({
      bundleText: 'function lazy(name) { return require(name); }',
    });
    expect(report.dynamicRequires).toHaveLength(1);
    expect(report.dynamicRequires[0].snippet).toContain('require(name)');
  });

  it('does not double-report requires that came from an external import', async () => {
    const report = await analyzeFlowBundleSafety({
      bundleText: 'var fs = require("node:fs");',
      metafile: metafileWith(
        {
          'virtual-entry.js': {
            bytes: 0,
            format: 'esm',
            imports: [
              { path: 'node:fs', kind: 'require-call', external: true },
            ],
          },
        },
        [{ path: 'node:fs', kind: 'require-call', external: true }]
      ),
    });
    expect(report.externalImports).toHaveLength(1);
    expect(report.dynamicRequires).toEqual([]);
  });
});

describe('assertFlowBundleIsSandboxSafe', () => {
  afterEach(() => {
    delete process.env[ALLOW_UNSAFE_FLOW_BUNDLE_ENV];
  });

  it('resolves for a safe bundle', async () => {
    await expect(
      assertFlowBundleIsSandboxSafe({ bundleText: 'var a = 1;' })
    ).resolves.toBeDefined();
  });

  it('throws a build error naming the module and the chain', async () => {
    const promise = assertFlowBundleIsSandboxSafe({
      bundleText: 'var fs = require("node:fs");',
      metafile: metafileWith(
        {
          'virtual-entry.js': {
            bytes: 0,
            format: 'esm',
            imports: [{ path: 'workflow.ts', kind: 'import-statement' }],
          },
          'workflow.ts': {
            bytes: 0,
            format: 'esm',
            imports: [
              { path: 'node:fs', kind: 'require-call', external: true },
            ],
          },
        },
        [{ path: 'node:fs', kind: 'require-call', external: true }]
      ),
    });
    await expect(promise).rejects.toThrow(/node:fs/);
    await expect(promise).rejects.toThrow(/workflow\.ts/);
    await expect(promise).rejects.toThrow(/use step/);
  });

  it('downgrades to a warning behind the escape hatch', async () => {
    process.env[ALLOW_UNSAFE_FLOW_BUNDLE_ENV] = '1';
    const warnings: string[] = [];
    const report = await assertFlowBundleIsSandboxSafe({
      bundleText: 'function lazy(name) { return require(name); }',
      warn: (message) => warnings.push(message),
    });
    expect(report.dynamicRequires).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('require');
  });
});
