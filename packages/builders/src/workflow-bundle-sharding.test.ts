import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import {
  selectWorkflowCode,
  type WorkflowCode,
} from '@workflow/core/runtime/workflow-code';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {}

  get shardingEnabled(): boolean {
    return this.shardWorkflowBundlesEnabled;
  }

  // This test exercises the VM bundle path. The real combined builder also
  // emits step registrations, but resolving `workflow/internal/builtins`
  // would require a consumer application's `workflow` package link.
  protected override async createStepsBundle() {
    return { context: undefined, manifest: {} };
  }

  createShardedBundle(
    inputFiles: string[],
    stepsOutfile: string,
    flowOutfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createCombinedBundle({
      inputFiles,
      stepsOutfile,
      flowOutfile,
      bundleFinalOutput: false,
      discoveredEntries,
      shardWorkflowBundles: true,
    });
  }
}

describe('workflow bundle sharding', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const outputDirs: string[] = [];

  afterEach(() => {
    for (const outputDir of outputDirs) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('uses one opt-in switch across production and watch builds', () => {
    const config: StandaloneConfig = {
      buildTarget: 'standalone',
      workingDir: repoRoot,
      stepsBundlePath: 'steps.mjs',
      workflowsBundlePath: 'workflows.mjs',
      webhookBundlePath: 'webhook.mjs',
      dirs: ['.'],
    };
    const previous = process.env.WORKFLOW_SHARD_VM_BUNDLES;
    try {
      process.env.WORKFLOW_SHARD_VM_BUNDLES = '1';
      expect(new TestBuilder(config).shardingEnabled).toBe(true);
      expect(new TestBuilder({ ...config, watch: true }).shardingEnabled).toBe(
        false
      );

      process.env.WORKFLOW_SHARD_VM_BUNDLES = '0';
      expect(new TestBuilder(config).shardingEnabled).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.WORKFLOW_SHARD_VM_BUNDLES;
      } else {
        process.env.WORKFLOW_SHARD_VM_BUNDLES = previous;
      }
    }
  });

  it('emits a workflow-to-bundle map for independent workflow sources', async () => {
    // Keep the fixture below the workbench so its workspace `workflow`
    // package link is available to esbuild while each test still gets a
    // private directory.
    const outputDir = mkdtempSync(
      join(repoRoot, 'workbench/nitro-v3/.workflow-shards-')
    );
    outputDirs.push(outputDir);
    const first = join(outputDir, 'first.ts');
    const second = join(outputDir, 'second.ts');
    const steps = join(outputDir, 'steps.mjs');
    const workflows = join(outputDir, 'workflows.mjs');
    writeFileSync(
      first,
      `export async function first(value: number) { 'use workflow'; return { generation: 'generation-one', value }; }\n`
    );
    writeFileSync(
      second,
      `export async function second(value: number) { 'use workflow'; return value + 2; }\n`
    );

    const config: StandaloneConfig = {
      buildTarget: 'standalone',
      workingDir: outputDir,
      projectRoot: repoRoot,
      moduleSpecifierRoot: repoRoot,
      dirs: ['.'],
      stepsBundlePath: steps,
      workflowsBundlePath: workflows,
      webhookBundlePath: join(outputDir, 'webhook.js'),
      sourcemap: false,
    };
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([first, second]),
      discoveredSerdeFiles: new Set(),
    };

    await new TestBuilder(config).createShardedBundle(
      [first, second],
      steps,
      workflows,
      discoveredEntries
    );

    const generated = readFileSync(workflows, 'utf8');
    expect(generated).toContain('workflowBundles');
    expect(generated).toContain('gzip-base64');
    expect(generated).toContain('bundle-0');
    expect(generated).toContain('bundle-1');

    // A failed rebuild must not publish a partial generation or leave the
    // previous output in a state that can be mixed with a later deterministic
    // bundle key. The next successful rebuild must publish the new generation
    // atomically from the caller's point of view.
    writeFileSync(
      first,
      `export async function first(value: number) { 'use workflow'; return value + ; }\n`
    );
    await expect(
      new TestBuilder(config).createShardedBundle(
        [first, second],
        steps,
        workflows,
        discoveredEntries
      )
    ).rejects.toThrow();
    expect(readFileSync(workflows, 'utf8')).toBe(generated);

    writeFileSync(
      first,
      `export async function first(value: number) { 'use workflow'; return { generation: 'generation-two', value }; }\n`
    );
    await new TestBuilder(config).createShardedBundle(
      [first, second],
      steps,
      workflows,
      discoveredEntries
    );
    const rebuilt = readFileSync(workflows, 'utf8');
    expect(rebuilt).not.toBe(generated);
  });

  it('keeps shared imports, serde classes, hooks, manifests, and sourcemaps in every shard', async () => {
    const outputDir = mkdtempSync(
      join(repoRoot, 'workbench/nitro-v3/.workflow-shards-')
    );
    outputDirs.push(outputDir);
    const shared = join(outputDir, 'shared.ts');
    const serde = join(outputDir, 'serde.ts');
    const first = join(outputDir, 'first.ts');
    const second = join(outputDir, 'second.ts');
    const steps = join(outputDir, 'steps.mjs');
    const workflows = join(outputDir, 'workflows.mjs');

    writeFileSync(
      shared,
      `export const sharedMarker = 'shared-local-marker';\n`
    );
    writeFileSync(
      serde,
      `export class GateValue {\n` +
        `  value: string;\n` +
        `  constructor(value: string) { this.value = value; }\n` +
        `  static classId = 'GateValue';\n` +
        `  static [Symbol.for('workflow-serialize')](value: GateValue) { return { value: value.value }; }\n` +
        `  static [Symbol.for('workflow-deserialize')](value: { value: string }) { return new GateValue(value.value); }\n` +
        `}\n`
    );
    writeFileSync(
      first,
      `import { sharedMarker } from './shared';\n` +
        `import { GateValue } from './serde';\n` +
        `const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];\n` +
        `export async function first(value: number) {\n` +
        `  'use workflow';\n` +
        `  const hook = createHook({ token: 'source-shard-first' });\n` +
        `  return { marker: firstMarker, sharedMarker, value, hookType: typeof hook, classId: GateValue.classId };\n` +
        `}\n` +
        `const firstMarker = 'first-only-marker';\n`
    );
    writeFileSync(
      second,
      `import { sharedMarker } from './shared';\n` +
        `import { GateValue } from './serde';\n` +
        `const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];\n` +
        `export async function second(value: number) {\n` +
        `  'use workflow';\n` +
        `  const hook = createHook({ token: 'source-shard-second' });\n` +
        `  return { marker: secondMarker, sharedMarker, value, hookType: typeof hook, classId: GateValue.classId };\n` +
        `}\n` +
        `const secondMarker = 'second-only-marker';\n`
    );

    const config: StandaloneConfig = {
      buildTarget: 'standalone',
      workingDir: outputDir,
      projectRoot: repoRoot,
      moduleSpecifierRoot: repoRoot,
      dirs: ['.'],
      stepsBundlePath: steps,
      workflowsBundlePath: workflows,
      webhookBundlePath: join(outputDir, 'webhook.js'),
      sourcemap: true,
    };
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([first, second]),
      discoveredSerdeFiles: new Set([serde]),
    };

    const result = await new TestBuilder(config).createShardedBundle(
      [first, second, serde],
      steps,
      workflows,
      discoveredEntries
    );
    const generated = readFileSync(workflows, 'utf8');
    const expressionStart =
      generated.indexOf('const workflowCode = ') +
      'const workflowCode = '.length;
    const expressionEnd = generated.indexOf('\n\n', expressionStart);
    expect(expressionStart).toBeGreaterThan('const workflowCode = '.length);
    expect(expressionEnd).toBeGreaterThan(expressionStart);
    const workflowCode = vm.runInNewContext(
      `(${generated.slice(expressionStart, expressionEnd).replace(/;$/, '')})`
    ) as WorkflowCode;

    const workflowIds = Object.values(result.manifest.workflows ?? {})
      .flatMap((entries) => Object.values(entries))
      .map((entry) => entry.workflowId);
    expect(workflowIds).toHaveLength(2);
    expect(result.manifest.classes).toHaveProperty('serde.ts');

    const bundles = workflowCode as Extract<WorkflowCode, object> & {
      workflowBundles?: Record<string, string>;
    };
    expect(Object.keys(bundles.workflowBundles ?? {})).toEqual(
      expect.arrayContaining(workflowIds)
    );

    const decoded = new Map<string, string>();
    const firstId = workflowIds.find((id) => id.endsWith('//first'));
    const secondId = workflowIds.find((id) => id.endsWith('//second'));
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    const firstCode = selectWorkflowCode(workflowCode, firstId!, decoded);
    const secondCode = selectWorkflowCode(workflowCode, secondId!, decoded);
    expect(firstCode).toContain('first-only-marker');
    expect(firstCode).toContain('shared-local-marker');
    expect(firstCode).toContain('source-shard-first');
    expect(firstCode).toContain('GateValue');
    expect(firstCode).toContain('sourceMappingURL=data:application/json');
    expect(firstCode).not.toContain('second-only-marker');
    expect(secondCode).toContain('second-only-marker');
    expect(secondCode).toContain('shared-local-marker');
    expect(secondCode).toContain('source-shard-second');
    expect(secondCode).toContain('GateValue');
    expect(secondCode).toContain('sourceMappingURL=data:application/json');
    expect(secondCode).not.toContain('first-only-marker');
  });
});
