import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

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

describe('workflow dependency pruning', () => {
  const outputDirs: string[] = [];

  afterEach(() => {
    for (const outputDir of outputDirs) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('does not bundle world schemas into a workflow without schemas', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const workingDir = join(repoRoot, 'workbench/nextjs-turbopack');
    const inputFile = join(workingDir, 'workflows/97_bench.ts');
    const outputDir = mkdtempSync(join(tmpdir(), 'workflow-pruning-'));
    outputDirs.push(outputDir);

    const config: StandaloneConfig = {
      buildTarget: 'standalone',
      workingDir,
      projectRoot: repoRoot,
      moduleSpecifierRoot: repoRoot,
      dirs: ['.'],
      stepsBundlePath: join(outputDir, 'steps.js'),
      workflowsBundlePath: join(outputDir, 'workflow.js'),
      webhookBundlePath: join(outputDir, 'webhook.js'),
      sourcemap: false,
    };
    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([inputFile]),
      discoveredSerdeFiles: new Set(),
    };

    const { interimBundleText } = await new TestBuilder(
      config
    ).createWorkflowBundle(
      inputFile,
      config.workflowsBundlePath,
      discoveredEntries
    );

    expect(interimBundleText).toBeDefined();
    expect(interimBundleText).not.toContain('/node_modules/zod');
  });
});
