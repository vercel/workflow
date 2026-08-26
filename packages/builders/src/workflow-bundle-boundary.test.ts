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
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import { importParents } from './discover-entries-esbuild-plugin.js';
import type { StandaloneConfig } from './types.js';
import {
  deserializeWorkflowBundle,
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
    `export const WORKFLOW_SERIALIZE = Symbol.for('workflow-serialize');
export const WORKFLOW_DESERIALIZE = Symbol.for('workflow-deserialize');\n`
  );
}

function serializerSource(name: string, dependency = ''): string {
  return `import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
${dependency}export class ${name} {
  static [WORKFLOW_SERIALIZE](value) { return { value: value.value }; }
  static [WORKFLOW_DESERIALIZE](data) { return new ${name}(data.value); }
}`;
}

describe('workflow bundle boundary', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const outputDirs: string[] = [];

  afterEach(() => {
    importParents.clear();
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

    const {
      bundles: { workflowBundles },
      interimBundleMetafile,
    } = await new TestBuilder(config).createWorkflowBundle(
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
    writeFileSync(join(workflowBundleDir, 'serializer.mjs'), 'user-owned');

    await new TestBuilder(config).createCombinedWorkflowBundle(
      [first, second],
      config.stepsBundlePath,
      config.workflowsBundlePath,
      discoveredEntries
    );

    const bundleFiles = readdirSync(workflowBundleDir)
      .filter((file) => /^\d.*\.mjs$/.test(file))
      .sort();
    expect(bundleFiles).toHaveLength(2);
    expect(
      bundleFiles.every((file) => /^\d+-[a-f0-9]{16}\.mjs$/.test(file))
    ).toBe(true);
    expect(readFileSync(join(workflowBundleDir, 'keep.txt'), 'utf8')).toBe(
      'user-owned'
    );
    expect(
      readFileSync(join(workflowBundleDir, 'serializer.mjs'), 'utf8')
    ).toBe('user-owned');
    const route = readFileSync(config.workflowsBundlePath, 'utf8');
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

  it('shares only dependency-isolated serializer registration', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const workingDir = join(repoRoot, 'workbench/nextjs-turbopack');
    const outputDir = mkdtempSync(join(workingDir, '.workflow-bootstrap-'));
    outputDirs.push(outputDir);
    const first = join(outputDir, 'first.ts');
    const second = join(outputDir, 'second.ts');
    const earlySerializer = join(outputDir, 'a-early-point.ts');
    const serializer = join(outputDir, 'r-point.ts');
    const dependentSerializer = join(outputDir, 'dependent-point.ts');
    const importedSerializer = join(outputDir, 'imported-point.ts');
    const hybridSerializer = join(outputDir, 'q-hybrid-point.ts');
    const isolatedSerializer = join(outputDir, 'z-isolated-point.ts');
    const step = join(outputDir, 'point-step.ts');
    const sharedState = join(outputDir, 'shared-state.ts');
    writeFileSync(sharedState, `export const sharedValue = 'shared-state';`);
    writeFileSync(
      earlySerializer,
      `${serializerSource('EarlyPoint')}
globalThis.__earlySerializerMarker = 'early-serializer-marker';`
    );
    writeFileSync(
      first,
      `import { sharedValue } from './shared-state';
import { ImportedPoint } from './imported-point';
import { createPoint, pointType } from './point-step';
export async function first() { "use workflow"; await createPoint(); return "first-workflow-marker" + sharedValue + pointType; }`
    );
    writeFileSync(
      second,
      `export async function second() { "use workflow"; return "second-workflow-marker"; }`
    );
    writeFileSync(
      serializer,
      `${serializerSource('SharedPoint')}
globalThis.__sharedSerializerMarker = 'shared-serializer-marker';`
    );
    writeFileSync(
      dependentSerializer,
      `${serializerSource('DependentPoint', "import { sharedValue } from './shared-state';\n")}
globalThis.__dependentSerializerMarker = sharedValue;`
    );
    writeFileSync(importedSerializer, serializerSource('ImportedPoint'));
    writeFileSync(hybridSerializer, serializerSource('HybridPoint'));
    writeFileSync(
      isolatedSerializer,
      `${serializerSource('IsolatedPoint')}
globalThis.__isolatedSerializerMarker = 'isolated-serializer-marker';`
    );
    writeFileSync(
      step,
      `import { HybridPoint } from './q-hybrid-point';
import { SharedPoint } from './r-point';
export const pointType = HybridPoint.name;
export async function createPoint() { "use step"; return new SharedPoint(); }`
    );
    importParents.set(first, new Set([importedSerializer, step]));
    importParents.set(step, new Set([hybridSerializer, serializer]));

    const config = createConfig(repoRoot, outputDir, outputDir, false);
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set([step]),
      discoveredWorkflows: new Set([first, second]),
      discoveredSerdeFiles: new Set([
        earlySerializer,
        serializer,
        dependentSerializer,
        importedSerializer,
        hybridSerializer,
        isolatedSerializer,
      ]),
    };
    writeWorkflowBuiltinsFixture(outputDir);

    await new TestBuilder(config).createCombinedWorkflowBundle(
      [first, second],
      config.stepsBundlePath,
      config.workflowsBundlePath,
      discoveredEntries
    );

    const workflowBundleDir = join(outputDir, 'workflow-bundles');
    const files = readdirSync(workflowBundleDir).filter((file) =>
      file.endsWith('.mjs')
    );
    const decoded = files.map((file) => ({
      file,
      code: deserializeWorkflowBundle(
        readFileSync(join(workflowBundleDir, file), 'utf8')
      ),
    }));
    const registry = decoded.filter(({ code }) =>
      code.includes('shared-serializer-marker')
    );
    const workflows = decoded.filter(({ code }) =>
      code.includes('workflow-marker')
    );

    expect(files).toHaveLength(3);
    expect(registry).toHaveLength(1);
    expect(registry[0]?.code).toContain('workflow-class-registry');
    expect(registry[0]?.code).not.toContain('EarlyPoint');
    expect(registry[0]?.code).not.toContain('DependentPoint');
    expect(registry[0]?.code).not.toContain('HybridPoint');
    expect(registry[0]?.code).not.toContain('ImportedPoint');
    expect(registry[0]?.code).toContain('IsolatedPoint');
    expect(workflows).toHaveLength(2);
    expect(workflows.every(({ code }) => !code.includes('SharedPoint'))).toBe(
      true
    );
    expect(workflows.every(({ code }) => !code.includes('IsolatedPoint'))).toBe(
      true
    );
    expect(workflows.every(({ code }) => code.includes('DependentPoint'))).toBe(
      true
    );
    expect(workflows.every(({ code }) => code.includes('ImportedPoint'))).toBe(
      true
    );
    expect(workflows.every(({ code }) => code.includes('EarlyPoint'))).toBe(
      true
    );
    expect(workflows.every(({ code }) => code.includes('HybridPoint'))).toBe(
      true
    );
    const route = readFileSync(config.workflowsBundlePath, 'utf8');
    expect(route).toContain(`workflow-bundles/${registry[0]?.file}`);
    expect(route).toContain('serializerRegistry');
  });

  it('refreshes generated VM bundles after a watch rebuild', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const workingDir = join(repoRoot, 'workbench/nextjs-turbopack');
    const outputDir = mkdtempSync(join(workingDir, '.workflow-watch-'));
    outputDirs.push(outputDir);
    const workflowFile = join(outputDir, 'watched.ts');
    const stableWorkflowFile = join(outputDir, 'z-stable.ts');
    const serializerFile = join(outputDir, 'watched-point.ts');
    writeFileSync(
      workflowFile,
      `export async function watched() { "use workflow"; return "before-watch"; }
export async function removedAfterWatch() { "use workflow"; return "remove-me"; }`
    );
    writeFileSync(
      stableWorkflowFile,
      `export async function stableWorkflow() { "use workflow"; return "stable"; }`
    );
    writeFileSync(
      serializerFile,
      `globalThis.__watchedSerializerMarker = 'before-watch-serde';`
    );
    const config = createConfig(repoRoot, outputDir, outputDir, true);
    writeWorkflowBuiltinsFixture(outputDir);
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([workflowFile, stableWorkflowFile]),
      discoveredSerdeFiles: new Set([serializerFile]),
    };
    const result = await new TestBuilder(config).createCombinedWorkflowBundle(
      [workflowFile, stableWorkflowFile],
      config.stepsBundlePath,
      config.workflowsBundlePath,
      discoveredEntries
    );
    assert(result.interimBundleCtx);
    assert(result.stepsContext);
    assert(result.bundleFinal);

    try {
      const workflowBundleDir = join(outputDir, 'workflow-bundles');
      const oldFiles = readdirSync(workflowBundleDir).filter((file) =>
        file.endsWith('.mjs')
      );
      const oldWorkflowFile = oldFiles.find((file) => /^0-/.test(file));
      assert(oldWorkflowFile);
      expect(oldFiles).toHaveLength(2);
      expect(oldFiles.some((file) => file.startsWith('serializer-'))).toBe(
        false
      );
      const oldStats = statSync(workflowFile);
      writeFileSync(
        workflowFile,
        `export async function watched() { "use workflow"; return "after--watch"; }
export async function renamedAfterWatch() { "use workflow"; return "rename-me"; }`
      );
      writeFileSync(
        serializerFile,
        `globalThis.__watchedSerializerMarker = 'after--watch-serde';`
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
      const currentWorkflowFile = currentFiles.find((file) => /^0-/.test(file));
      assert(currentWorkflowFile);
      expect(currentWorkflowFile).not.toBe(oldWorkflowFile);
      expect(route).not.toContain('serializerRegistry');
      expect(route).toContain('Promise.resolve');
      expect(route).toContain('renamedAfterWatch');
      expect(route).not.toContain('removedAfterWatch');
      expect(route).not.toContain('after--watch');
      const currentBundle = await import(
        pathToFileURL(join(workflowBundleDir, currentWorkflowFile)).href
      );
      expect(Buffer.from(currentBundle.default, 'base64').toString()).toContain(
        'after--watch'
      );
      expect(Buffer.from(currentBundle.default, 'base64').toString()).toContain(
        'after--watch-serde'
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
