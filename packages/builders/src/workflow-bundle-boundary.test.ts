import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';
import {
  deserializeWorkflowBundle,
  isWorkflowBundleFileName,
  referencedWorkflowBundleFileNames,
  serializeWorkflowBundle,
} from './workflow-bundle-module.js';
import { extractWorkflowGraphs } from './workflows-extractor.js';

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
      includeMetafile: true,
      discoveredEntries,
    });
  }

  createCombinedWorkflowBundle(
    inputFiles: string[],
    stepsOutfile: string,
    flowOutfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createCombinedBundle({
      inputFiles,
      stepsOutfile,
      flowOutfile,
      bundleFinalOutput: true,
      discoveredEntries,
    });
  }

  createManifestForTest({
    workflowBundlePath,
    manifestDir,
    manifest,
  }: {
    workflowBundlePath: string;
    manifestDir: string;
    manifest: WorkflowManifest;
  }) {
    return this.createManifest({
      workflowBundlePath,
      manifestDir,
      manifest,
    });
  }
}

function createConfig(
  repoRoot: string,
  workingDir: string,
  outputDir: string,
  watch: boolean
): StandaloneConfig {
  return {
    buildTarget: 'standalone',
    workingDir,
    projectRoot: repoRoot,
    moduleSpecifierRoot: repoRoot,
    dirs: ['.'],
    stepsBundlePath: join(outputDir, 'steps.js'),
    workflowsBundlePath: join(outputDir, 'flow.js'),
    webhookBundlePath: join(outputDir, 'webhook.js'),
    sourcemap: false,
    watch,
  };
}

function writeWorkflowBuiltinsFixture(root: string): void {
  const packageDir = join(root, 'node_modules/workflow');
  const serdePackageDir = join(root, 'node_modules/@workflow/serde');
  mkdirSync(join(packageDir, 'internal'), { recursive: true });
  mkdirSync(serdePackageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'workflow',
      version: '0.0.0-test',
      exports: {
        './internal/builtins': './internal/builtins.js',
        './runtime': './runtime.js',
      },
    })
  );
  writeFileSync(join(packageDir, 'internal/builtins.js'), 'export {};\n');
  writeFileSync(
    join(packageDir, 'runtime.js'),
    'export const workflowEntrypoint = () => async () => {};\n'
  );
  writeFileSync(
    join(serdePackageDir, 'package.json'),
    JSON.stringify({
      name: '@workflow/serde',
      version: '0.0.0-test',
      type: 'module',
      exports: './index.js',
    })
  );
  writeFileSync(
    join(serdePackageDir, 'index.js'),
    `export const WORKFLOW_SERIALIZE = Symbol.for('workflow.serialize');
export const WORKFLOW_DESERIALIZE = Symbol.for('workflow.deserialize');\n`
  );
}

describe('workflow bundle boundary', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const outputDirs: string[] = [];

  afterEach(() => {
    for (const outputDir of outputDirs) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('round-trips VM source without exposing nested template syntax', () => {
    const code =
      'const value = `hello $' + '{name}`;\u2028const done = true;\u2029';
    const moduleCode = serializeWorkflowBundle(code);

    expect(moduleCode).not.toContain('`');
    expect(moduleCode).not.toContain('${');
    expect(moduleCode).not.toContain('\u2028');
    expect(moduleCode).not.toContain('\u2029');
    expect(deserializeWorkflowBundle(moduleCode)).toBe(code);
  });

  async function getWorkflowBundleInputs(source: string): Promise<string[]> {
    // Keep the fixture beneath this package so its workspace dependencies are
    // resolved exactly as they are for a real consumer workflow.
    const outputDir = mkdtempSync(
      join(import.meta.dirname, '.workflow-pruning-')
    );
    outputDirs.push(outputDir);
    const inputFile = join(outputDir, 'workflow.ts');
    writeFileSync(inputFile, source);

    const config = createConfig(repoRoot, outputDir, outputDir, false);
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([inputFile]),
      discoveredSerdeFiles: new Set(),
    };

    const { workflowBundles, interimBundleMetafile } = await new TestBuilder(
      config
    ).createWorkflowBundle(
      inputFile,
      config.workflowsBundlePath,
      discoveredEntries
    );

    expect(workflowBundles).toHaveLength(1);
    expect(interimBundleMetafile).toBeDefined();
    return Object.keys(interimBundleMetafile?.inputs ?? {}).map((input) =>
      input.replaceAll('\\', '/')
    );
  }

  function expectNoZodInputs(inputs: string[]): void {
    expect(
      inputs.filter((input) => input.includes('/node_modules/zod/'))
    ).toEqual([]);
  }

  it('does not bundle world schemas into a minimal workflow', async () => {
    const inputs = await getWorkflowBundleInputs(
      `export async function minimal() { "use workflow"; return 1; }`
    );

    expectNoZodInputs(inputs);
  });

  it('does not bundle world schemas for core workflow APIs', async () => {
    const inputs = await getWorkflowBundleInputs(`
      import { createHook, setAttributes } from '@workflow/core';

      async function basicStep(value: number) {
        "use step";
        return value + 1;
      }

      export async function realisticWorkflow() {
        "use workflow";
        await setAttributes({ phase: 'started' });
        const hook = createHook<number>();
        return basicStep(await hook);
      }
    `);

    expectNoZodInputs(inputs);
  });

  it('emits one lazy VM bundle per workflow source', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const workingDir = join(repoRoot, 'workbench/nextjs-turbopack');
    const outputDir = mkdtempSync(join(workingDir, '.workflow-sources-'));
    outputDirs.push(outputDir);
    const first = join(outputDir, 'first.ts');
    const second = join(outputDir, 'second.ts');
    writeFileSync(
      first,
      `import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
export class HybridSerde {
  static [WORKFLOW_SERIALIZE](value) { return { value: value.value }; }
  static [WORKFLOW_DESERIALIZE](data) { return new HybridSerde(data.value); }
  constructor(value) { this.value = value; }
}
export async function first() { "use workflow"; return "lazy-first-marker"; }
export async function alsoFirst() { "use workflow"; return 2; }`
    );
    writeFileSync(
      second,
      `export async function second() { "use workflow"; return "lazy-second-marker"; }`
    );

    const config = createConfig(repoRoot, outputDir, outputDir, false);
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([second, first]),
      discoveredSerdeFiles: new Set([first]),
    };
    const workflowBundleDir = join(outputDir, 'workflow-bundles');
    writeWorkflowBuiltinsFixture(outputDir);
    mkdirSync(workflowBundleDir);
    writeFileSync(join(workflowBundleDir, 'keep.txt'), 'user-owned');
    writeFileSync(join(workflowBundleDir, 'keep.mjs'), 'user-owned');
    const staleBundle = `${'0'.repeat(64)}.mjs`;
    writeFileSync(join(workflowBundleDir, staleBundle), 'stale');

    await new TestBuilder(config).createCombinedWorkflowBundle(
      [first, second],
      config.stepsBundlePath,
      config.workflowsBundlePath,
      discoveredEntries
    );

    const bundleFiles = readdirSync(workflowBundleDir)
      .filter(isWorkflowBundleFileName)
      .sort();
    expect(bundleFiles).toHaveLength(2);
    expect(readFileSync(join(workflowBundleDir, 'keep.txt'), 'utf8')).toBe(
      'user-owned'
    );
    expect(readFileSync(join(workflowBundleDir, 'keep.mjs'), 'utf8')).toBe(
      'user-owned'
    );
    expect(() => readFileSync(join(workflowBundleDir, staleBundle))).toThrow(
      /ENOENT/
    );
    const route = readFileSync(config.workflowsBundlePath, 'utf8');
    expect(route).toContain('createWorkflowBundleLoader');
    expect(route).not.toContain('workflowBundlePromise');
    expect(route).toContain(`workflow-bundles/${bundleFiles[0]}`);
    expect(route).toContain(`workflow-bundles/${bundleFiles[1]}`);
    expect(route.match(/: loadWorkflowBundle0,/g)).toHaveLength(2);
    expect(route.match(/: loadWorkflowBundle1/g)).toHaveLength(1);
    expect(route).not.toContain('lazy-first-marker');
    const firstBundle = await import(
      `${pathToFileURL(join(workflowBundleDir, bundleFiles[0])).href}?test`
    );
    const secondBundle = await import(
      `${pathToFileURL(join(workflowBundleDir, bundleFiles[1])).href}?test`
    );
    const firstCode = Buffer.from(firstBundle.default, 'base64').toString();
    const secondCode = Buffer.from(secondBundle.default, 'base64').toString();
    expect(firstCode).toContain('lazy-first-marker');
    expect(firstCode).not.toContain('lazy-second-marker');
    expect(secondCode).toContain('HybridSerde');
  });

  it('creates a step-only manifest without a lazy workflow bundle', async () => {
    const workingDir = join(repoRoot, 'workbench/nextjs-turbopack');
    const outputDir = mkdtempSync(join(workingDir, '.workflow-step-only-'));
    outputDirs.push(outputDir);
    const stepFile = join(outputDir, 'step.ts');
    writeFileSync(
      stepFile,
      `export async function onlyStep() { "use step"; return "done"; }`
    );
    writeWorkflowBuiltinsFixture(outputDir);

    const config = createConfig(repoRoot, outputDir, outputDir, false);
    const builder = new TestBuilder(config);
    const { manifest } = await builder.createCombinedWorkflowBundle(
      [stepFile],
      config.stepsBundlePath,
      config.workflowsBundlePath,
      {
        discoveredSteps: new Set([stepFile]),
        discoveredWorkflows: new Set(),
        discoveredSerdeFiles: new Set(),
      }
    );

    const route = readFileSync(config.workflowsBundlePath, 'utf8');
    expect(referencedWorkflowBundleFileNames(route)).toEqual([]);
    await expect(
      builder.createManifestForTest({
        workflowBundlePath: config.workflowsBundlePath,
        manifestDir: outputDir,
        manifest,
      })
    ).resolves.toBeDefined();
    const generatedManifest = JSON.parse(
      readFileSync(join(outputDir, 'manifest.json'), 'utf8')
    );
    expect(
      Object.values<Record<string, unknown>>(generatedManifest.steps).flatMap(
        (steps) => Object.keys(steps)
      )
    ).toContain('onlyStep');
    expect(generatedManifest.workflows).toEqual({});
    expect(generatedManifest.classes).toEqual({});
  });

  it('keeps unchanged sidecar names with inline maps after insertion', async () => {
    const workingDir = join(repoRoot, 'workbench/nextjs-turbopack');
    const outputDir = mkdtempSync(join(workingDir, '.workflow-stable-names-'));
    outputDirs.push(outputDir);
    const middle = join(outputDir, 'middle.ts');
    const later = join(outputDir, 'later.ts');
    const earlier = join(outputDir, 'earlier.ts');
    writeFileSync(
      middle,
      `export async function middle() { "use workflow"; return "middle"; }`
    );
    writeFileSync(
      later,
      `export async function later() { "use workflow"; return "later"; }`
    );
    writeFileSync(
      earlier,
      `export async function earlier() { "use workflow"; return "earlier"; }`
    );
    writeWorkflowBuiltinsFixture(outputDir);
    const config = createConfig(repoRoot, outputDir, outputDir, false);
    config.sourcemap = 'inline';
    const workflowBundleDir = join(outputDir, 'workflow-bundles');
    const build = async (workflowFiles: string[]) => {
      await new TestBuilder(config).createCombinedWorkflowBundle(
        workflowFiles,
        config.stepsBundlePath,
        config.workflowsBundlePath,
        {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set(workflowFiles),
          discoveredSerdeFiles: new Set(),
        }
      );
      return new Set(readdirSync(workflowBundleDir));
    };

    const originalFiles = await build([middle, later]);
    const [originalFile] = originalFiles;
    assert(originalFile);
    expect(
      deserializeWorkflowBundle(
        readFileSync(join(workflowBundleDir, originalFile), 'utf8')
      )
    ).toContain('sourceMappingURL=data:application/json;base64,');
    const updatedFiles = await build([earlier, middle, later]);

    expect(originalFiles.size).toBe(2);
    expect(updatedFiles.size).toBe(3);
    for (const file of originalFiles) {
      expect(updatedFiles.has(file)).toBe(true);
    }
  });

  it('refreshes the generated VM bundle after a watch rebuild', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const workingDir = join(repoRoot, 'workbench/nextjs-turbopack');
    const outputDir = mkdtempSync(join(workingDir, '.workflow-watch-'));
    outputDirs.push(outputDir);
    const workflowFile = join(outputDir, 'watched.ts');
    writeFileSync(
      workflowFile,
      `export async function watched() { "use workflow"; return "before-watch"; }
export async function removedAfterWatch() { "use workflow"; return "remove-me"; }`
    );
    const config = createConfig(repoRoot, outputDir, outputDir, true);
    writeWorkflowBuiltinsFixture(outputDir);
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([workflowFile]),
      discoveredSerdeFiles: new Set(),
    };
    const result = await new TestBuilder(config).createCombinedWorkflowBundle(
      [workflowFile],
      config.stepsBundlePath,
      config.workflowsBundlePath,
      discoveredEntries
    );
    assert(result.interimBundleCtx);
    assert(result.stepsContext);
    assert(result.bundleFinal);

    try {
      const workflowBundleDir = join(outputDir, 'workflow-bundles');
      const oldFile = readdirSync(workflowBundleDir).find((file) =>
        file.endsWith('.mjs')
      );
      assert(oldFile);
      const oldBundlePath = join(workflowBundleDir, oldFile);
      const oldBundleTimestamp = new Date('2001-01-01T00:00:00.000Z');
      utimesSync(oldBundlePath, oldBundleTimestamp, oldBundleTimestamp);
      const unchangedRebuild = await result.interimBundleCtx.rebuild();
      await result.bundleFinal(unchangedRebuild);
      expect(statSync(oldBundlePath).mtimeMs).toBe(
        oldBundleTimestamp.getTime()
      );

      const oldStats = statSync(workflowFile);
      writeFileSync(
        workflowFile,
        `export async function watched() { "use workflow"; return "after--watch"; }
export async function renamedAfterWatch() { "use workflow"; return "rename-me"; }`
      );
      // Reproduce a coalesced watcher update that is indistinguishable to the
      // legacy size/mtime manifest cache while esbuild rebuilds new code.
      utimesSync(workflowFile, oldStats.atime, oldStats.mtime);

      const rebuild = await result.interimBundleCtx.rebuild();
      await result.bundleFinal(rebuild);

      const route = readFileSync(config.workflowsBundlePath, 'utf8');
      const currentFiles = readdirSync(workflowBundleDir).filter((file) =>
        file.endsWith('.mjs')
      );
      expect(currentFiles).toHaveLength(2);
      expect(currentFiles).toContain(oldFile);
      const [currentFile] = referencedWorkflowBundleFileNames(route);
      assert(currentFile);
      expect(currentFile).not.toBe(oldFile);
      expect(currentFiles).toContain(currentFile);
      expect(route).toContain('import(');
      expect(route).not.toContain('Promise.resolve');
      expect(route).toContain('renamedAfterWatch');
      expect(route).not.toContain('removedAfterWatch');
      expect(route).not.toContain('after--watch');
      const currentBundle = await import(
        pathToFileURL(join(workflowBundleDir, currentFile)).href
      );
      expect(Buffer.from(currentBundle.default, 'base64').toString()).toContain(
        'after--watch'
      );
      const oldBundle = await import(
        `${pathToFileURL(oldBundlePath).href}?after-rebuild`
      );
      expect(Buffer.from(oldBundle.default, 'base64').toString()).toContain(
        'before-watch'
      );
      const graphs = await extractWorkflowGraphs(config.workflowsBundlePath);
      expect(JSON.stringify(graphs)).toContain('watched');
      expect(JSON.stringify(graphs)).toContain('renamedAfterWatch');
      expect(JSON.stringify(graphs)).not.toContain('removedAfterWatch');
    } finally {
      await Promise.all([
        result.interimBundleCtx.dispose(),
        result.stepsContext.dispose(),
      ]);
    }
  });
});
