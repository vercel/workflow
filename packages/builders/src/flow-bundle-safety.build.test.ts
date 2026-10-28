import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import { ALLOW_UNSAFE_FLOW_BUNDLE_ENV } from './flow-bundle-safety.js';
import type { StandaloneConfig } from './types.js';

/**
 * End-to-end coverage for the sandbox-safety check: these build a real
 * workflow bundle so the assertions run against esbuild's actual CJS output
 * and metafile, not a hand-written approximation of them.
 */

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {}

  createWorkflowBundle(
    inputFile: string,
    outfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createWorkflowsBundle({
      inputFiles: [inputFile],
      outfile,
      bundleFinalOutput: false,
      discoveredEntries,
    });
  }
}

describe('flow bundle sandbox safety (esbuild)', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const outputDirs: string[] = [];

  afterEach(() => {
    for (const outputDir of outputDirs) {
      rmSync(outputDir, { recursive: true, force: true });
    }
    outputDirs.length = 0;
    delete process.env[ALLOW_UNSAFE_FLOW_BUNDLE_ENV];
  });

  /**
   * Keep fixtures beneath this package so their workspace dependencies resolve
   * exactly as they do for a real consumer workflow.
   */
  function createFixture(files: Record<string, string>): string {
    const outputDir = mkdtempSync(join(import.meta.dirname, '.flow-safety-'));
    outputDirs.push(outputDir);
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = join(outputDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, contents, 'utf8');
    }
    return outputDir;
  }

  function buildWorkflow(outputDir: string) {
    const inputFile = join(outputDir, 'workflow.ts');
    const config: StandaloneConfig = {
      buildTarget: 'standalone',
      workingDir: outputDir,
      projectRoot: repoRoot,
      moduleSpecifierRoot: repoRoot,
      dirs: ['.'],
      stepsBundlePath: join(outputDir, 'steps.js'),
      workflowsBundlePath: join(outputDir, 'workflow.js'),
      webhookBundlePath: join(outputDir, 'webhook.js'),
      sourcemap: false,
      suppressCreateWorkflowsBundleLogs: true,
      suppressCreateWorkflowsBundleWarnings: true,
    };
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([inputFile]),
      discoveredSerdeFiles: new Set(),
    };
    return new TestBuilder(config).createWorkflowBundle(
      inputFile,
      config.workflowsBundlePath,
      discoveredEntries
    );
  }

  function packageFiles(
    name: string,
    contents: string
  ): Record<string, string> {
    return {
      [`node_modules/${name}/package.json`]: JSON.stringify({
        name,
        version: '1.0.0',
        main: 'index.js',
      }),
      [`node_modules/${name}/index.js`]: contents,
    };
  }

  it('builds a workflow whose dependency only uses bundled CommonJS', async () => {
    const outputDir = createFixture({
      ...packageFiles(
        'safe-pkg',
        [
          "const inner = require('./inner.js');",
          "const isNode = typeof require === 'function';",
          'module.exports.greet = () => `${inner.name}:${isNode}`;',
        ].join('\n')
      ),
      'node_modules/safe-pkg/inner.js': "module.exports = { name: 'inner' };",
      'workflow.ts': [
        "import { greet } from 'safe-pkg';",
        'export async function wf() { "use workflow"; return greet(); }',
      ].join('\n'),
    });

    const { interimBundleText } = await buildWorkflow(outputDir);

    // `require('./inner.js')` is rewritten to esbuild's `require_inner()`
    // wrapper and `typeof require` never throws, so neither is a violation.
    expect(interimBundleText).toContain('require_inner');
    expect(interimBundleText).toContain('typeof require');
  });

  it('builds a workflow that reaches a guarded optional-dependency probe', async () => {
    // The shape framer-motion ships: `require` is expected to be missing and
    // the resulting ReferenceError is caught, so the bundle still loads.
    const outputDir = createFixture({
      'optional-probe.ts': [
        'export let isValidProp: ((key: string) => boolean) | undefined;',
        'try {',
        '  isValidProp = require("@emotion/is-prop-valid").default;',
        '} catch {',
        '  // optional dependency, fall back to the default',
        '}',
      ].join('\n'),
      'workflow.ts': [
        "import { isValidProp } from './optional-probe.js';",
        'export async function wf() { "use workflow"; return Boolean(isValidProp); }',
      ].join('\n'),
    });

    const { interimBundleText } = await buildWorkflow(outputDir);

    expect(interimBundleText).toContain('@emotion/is-prop-valid');
  });

  it('builds a workflow whose dependency only requires a builtin behind a typeof check', async () => {
    // tweetnacl's shape: `require("crypto")` is external in the bundle, but it
    // only runs when `require` exists, which it never does in the sandbox.
    const outputDir = createFixture({
      ...packageFiles(
        'guarded-pkg',
        [
          'var crypto;',
          "if (typeof self !== 'undefined' && self.crypto) {",
          '  crypto = self.crypto;',
          "} else if (typeof require !== 'undefined') {",
          "  crypto = require('crypto');",
          '}',
          'module.exports.hasCrypto = () => Boolean(crypto);',
        ].join('\n')
      ),
      ...packageFiles(
        'wrapper-pkg',
        "module.exports = require('guarded-pkg');"
      ),
      'workflow.ts': [
        "import { hasCrypto } from 'wrapper-pkg';",
        'export async function wf() { "use workflow"; return hasCrypto(); }',
      ].join('\n'),
    });

    const { interimBundleText } = await buildWorkflow(outputDir);

    expect(interimBundleText).toContain('require("crypto")');
    const context = createContext({ module: { exports: {} }, exports: {} });
    expect(() =>
      runInContext(interimBundleText as string, context)
    ).not.toThrow();
  });

  it('fails when a transitive dependency pulls in a Node.js builtin', async () => {
    const outputDir = createFixture({
      ...packageFiles(
        'leaky-pkg',
        [
          "const fs = require('node:fs');",
          "module.exports.readIt = () => fs.readFileSync('x');",
        ].join('\n')
      ),
      ...packageFiles(
        'wrapper-pkg',
        [
          "const leaky = require('leaky-pkg');",
          'module.exports.go = () => leaky.readIt();',
        ].join('\n')
      ),
      'workflow.ts': [
        "import { go } from 'wrapper-pkg';",
        'export async function wf() { "use workflow"; return go(); }',
      ].join('\n'),
    });

    const error = await buildWorkflow(outputDir).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('node:fs');
    expect(message).toContain('node_modules/leaky-pkg/index.js');
    // The chain names the user file that started it.
    expect(message).toContain('workflow.ts');
    expect(message).toContain('node_modules/wrapper-pkg/index.js');
    expect(message).toContain('use step');
  });

  it('fails when a builtin arrives through a re-export', async () => {
    const outputDir = createFixture({
      ...packageFiles(
        'reexported-pkg',
        [
          "const os = require('node:os');",
          'module.exports.platform = () => os.platform();',
        ].join('\n')
      ),
      'reexport.ts': "export * from 'reexported-pkg';",
      'workflow.ts': [
        "import { platform } from './reexport.js';",
        'export async function wf() { "use workflow"; return platform(); }',
      ].join('\n'),
    });

    const error = await buildWorkflow(outputDir).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('node:os');
    expect((error as Error).message).toContain('reexport.ts');
  });

  it('fails on a user-written dynamic require in workflow code', async () => {
    const outputDir = createFixture({
      'workflow.ts': [
        'export async function wf(name: string) {',
        '  "use workflow";',
        '  return require(name).value;',
        '}',
      ].join('\n'),
    });

    const error = await buildWorkflow(outputDir).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Unresolved require() calls');
    expect(message).toContain('require(name)');
  });

  it('fails on a dynamic require inside a bundled dependency', async () => {
    const outputDir = createFixture({
      ...packageFiles(
        'lazy-pkg',
        [
          'module.exports.load = (name) => require(name);',
          "module.exports.ok = () => 'ok';",
        ].join('\n')
      ),
      'workflow.ts': [
        "import { load } from 'lazy-pkg';",
        'export async function wf() { "use workflow"; return load("x"); }',
      ].join('\n'),
    });

    const error = await buildWorkflow(outputDir).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'node_modules/lazy-pkg/index.js'
    );
  });

  it('downgrades to a warning behind the escape hatch', async () => {
    process.env[ALLOW_UNSAFE_FLOW_BUNDLE_ENV] = '1';
    const outputDir = createFixture({
      ...packageFiles(
        'leaky-pkg',
        [
          "const fs = require('node:fs');",
          "module.exports.readIt = () => fs.readFileSync('x');",
        ].join('\n')
      ),
      ...packageFiles(
        'wrapper-pkg',
        [
          "const leaky = require('leaky-pkg');",
          'module.exports.go = () => leaky.readIt();',
        ].join('\n')
      ),
      'workflow.ts': [
        "import { go } from 'wrapper-pkg';",
        'export async function wf() { "use workflow"; return go(); }',
      ].join('\n'),
    });

    const { interimBundleText } = await buildWorkflow(outputDir);

    expect(interimBundleText).toContain('require("node:fs")');

    // ...and that bundle is exactly what the check exists to stop: evaluating
    // it the way the runtime does throws before any workflow can start.
    // Mirrors the workflow sandbox: `module`/`exports` shims, no `require`.
    const context = createContext({ module: { exports: {} }, exports: {} });
    expect(() => runInContext(interimBundleText as string, context)).toThrow(
      /require is not defined/
    );
  });
});
