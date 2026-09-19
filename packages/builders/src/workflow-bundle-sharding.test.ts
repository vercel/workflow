import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {}

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
      `export async function first(value: number) { 'use workflow'; return value + 1; }\n`
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
  });
});
