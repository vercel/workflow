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

  /**
   * Evaluates a flow bundle the way the runtime does (`module`/`exports`
   * shims, no `require`) and returns its registered workflows.
   */
  function loadFlowBundle(bundleText: string) {
    const context = createContext({ module: { exports: {} }, exports: {} });
    runInContext(bundleText, context);
    return runInContext('globalThis.__private_workflows', context) as Map<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
  }

  function onlyWorkflow(bundleText: string) {
    const workflows = [...loadFlowBundle(bundleText).values()];
    expect(workflows).toHaveLength(1);
    return workflows[0];
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

    // The guard still never takes the `require` branch in the sandbox.
    expect(interimBundleText).toContain('typeof require');
    await expect(onlyWorkflow(interimBundleText as string)()).resolves.toBe(
      false
    );
  });

  it('builds a workflow whose dependency imports a Node.js builtin it never calls', async () => {
    // The shape of an AI provider SDK reached through a barrel file: the
    // package is bundled because the barrel imports it, and its dependency
    // picks a checksum implementation and imports `node:crypto` at module
    // load, but no workflow ever calls into it.
    const outputDir = createFixture({
      'node_modules/checksum-pkg/package.json': JSON.stringify({
        name: 'checksum-pkg',
        version: '1.0.0',
        type: 'module',
        module: 'index.js',
      }),
      'node_modules/checksum-pkg/index.js': [
        "import * as zlib from 'node:zlib';",
        "import { createHash } from 'node:crypto';",
        "const native = typeof zlib.crc32 === 'function' ? zlib.crc32 : undefined;",
        'export const crc32 = (data) => (native ? native(data) : 0);',
        "export const md5 = (data) => createHash('md5').update(data).digest('hex');",
      ].join('\n'),
      'node_modules/provider-pkg/package.json': JSON.stringify({
        name: 'provider-pkg',
        version: '1.0.0',
        type: 'module',
        module: 'index.js',
      }),
      'node_modules/provider-pkg/index.js': [
        "import { crc32, md5 } from 'checksum-pkg';",
        'export const providers = { crc32, md5 };',
      ].join('\n'),
      'registry.ts': [
        "import { providers } from 'provider-pkg';",
        'export const registry = { checksum: providers, other: {} };',
      ].join('\n'),
      'workflow.ts': [
        "import { registry } from './registry.js';",
        'export async function wf() { "use workflow"; return Object.keys(registry); }',
      ].join('\n'),
    });

    const { interimBundleText } = await buildWorkflow(outputDir);

    expect(interimBundleText).not.toMatch(/require\("node:/);
    // The dependency is really in the bundle, with the stand-ins.
    expect(interimBundleText).toContain('NodeJsModuleInWorkflowError');
    await expect(onlyWorkflow(interimBundleText as string)()).resolves.toEqual([
      'checksum',
      'other',
    ]);
  });

  it('throws when a workflow calls into a builtin a dependency imports', async () => {
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
          "module.exports.ok = () => 'ok';",
        ].join('\n')
      ),
      'workflow.ts': [
        "import { go, ok } from 'wrapper-pkg';",
        'export async function wf(read: boolean) { "use workflow"; return read ? go() : ok(); }',
      ].join('\n'),
    });

    const { interimBundleText } = await buildWorkflow(outputDir);

    expect(interimBundleText).not.toContain('require("node:fs")');
    const wf = onlyWorkflow(interimBundleText as string);
    await expect(wf(false)).resolves.toBe('ok');
    // The error is created inside the VM, so it is not this realm's `Error`.
    const error = await wf(true).catch((e: Error) => e);
    expect((error as Error).name).toBe('NodeJsModuleInWorkflowError');
    expect((error as Error).message).toContain('node:fs.readFileSync');
    expect((error as Error).message).toContain('use step');
  });

  it('throws when a workflow calls a builtin that arrives through a re-export', async () => {
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

    const { interimBundleText } = await buildWorkflow(outputDir);

    await expect(onlyWorkflow(interimBundleText as string)()).rejects.toThrow(
      /node:os\.platform/
    );
  });

  it('fails when workflow code imports a Node.js builtin itself', async () => {
    const outputDir = createFixture({
      'workflow.ts': [
        "import { readFileSync } from 'node:fs';",
        'export async function wf() { "use workflow"; return readFileSync("x"); }',
      ].join('\n'),
    });

    const error = await buildWorkflow(outputDir).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('node:fs');
  });

  it('fails when user code outside the workflow file imports a Node.js builtin', async () => {
    const outputDir = createFixture({
      'helper.ts': [
        "import * as os from 'node:os';",
        'export const hostname = os.hostname;',
      ].join('\n'),
      'workflow.ts': [
        "import { hostname } from './helper.js';",
        'export async function wf() { "use workflow"; return hostname(); }',
      ].join('\n'),
    });

    const error = await buildWorkflow(outputDir).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('node:os');
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
      'loader.ts': [
        "const name = ['node', 'fs'].join(':');",
        'export const fs = require(name);',
      ].join('\n'),
      'workflow.ts': [
        "import { fs } from './loader.js';",
        'export async function wf() { "use workflow"; return Boolean(fs); }',
      ].join('\n'),
    });

    const { interimBundleText } = await buildWorkflow(outputDir);

    expect(interimBundleText).toContain('require(name)');

    // ...and that bundle is exactly what the check exists to stop: evaluating
    // it the way the runtime does throws before any workflow can start.
    expect(() => loadFlowBundle(interimBundleText as string)).toThrow(
      /require is not defined/
    );
  });
});
