import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {}

  discoverWorkflowEntries(inputFile: string, outputDir: string) {
    return this.discoverEntries([inputFile], outputDir);
  }

  createWorkflowBundle(
    inputFile: string,
    outfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createWorkflowsBundle({
      inputFiles: [inputFile],
      outfile,
      bundleFinalOutput: false,
      includeMetafile: true,
      discoveredEntries,
    });
  }
}

describe('workflow bundle boundary', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const outputDirs: string[] = [];

  afterEach(() => {
    for (const outputDir of outputDirs) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  async function buildWorkflow(source: string): Promise<{
    inputs: string[];
    serdeOnlyFiles: string[];
  }> {
    // Keep the fixture beneath this package so its workspace dependencies are
    // resolved exactly as they are for a real consumer workflow.
    const outputDir = mkdtempSync(
      join(import.meta.dirname, '.workflow-pruning-')
    );
    outputDirs.push(outputDir);
    const inputFile = join(outputDir, 'workflow.ts');
    writeFileSync(inputFile, source);

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
    };
    const builder = new TestBuilder(config);
    const discoveredEntries = await builder.discoverWorkflowEntries(
      inputFile,
      outputDir
    );
    const { interimBundleMetafile } = await builder.createWorkflowBundle(
      inputFile,
      config.workflowsBundlePath,
      discoveredEntries
    );

    expect(interimBundleMetafile).toBeDefined();
    return {
      inputs: Object.keys(interimBundleMetafile?.inputs ?? {}).map((input) =>
        input.replaceAll('\\', '/')
      ),
      serdeOnlyFiles: [...discoveredEntries.discoveredSerdeFiles].map((file) =>
        file.replaceAll('\\', '/')
      ),
    };
  }

  function expectNoZodInputs(inputs: string[]): void {
    expect(
      inputs.filter((input) => input.includes('/node_modules/zod/'))
    ).toEqual([]);
  }

  it('does not bundle world schemas into a minimal workflow', async () => {
    const { inputs } = await buildWorkflow(
      `export async function minimal() { "use workflow"; return 1; }`
    );

    expectNoZodInputs(inputs);
  });

  it('does not bundle world schemas for core workflow APIs', async () => {
    const { inputs } = await buildWorkflow(`
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

  it('uses the workflow-safe Chain export without discovering the host class', async () => {
    const { inputs, serdeOnlyFiles } = await buildWorkflow(`
      import { Chain } from '@workflow/core';

      async function extend(chain: Chain<number>) {
        "use step";
        return chain.append(2);
      }

      export async function chainWorkflow(chain: Chain<number>) {
        "use workflow";
        if (!(chain instanceof Chain)) throw new Error('not a Chain');
        return extend(chain.take(1));
      }
    `);

    expect(
      serdeOnlyFiles.filter((file) => file.endsWith('core/dist/chain.js'))
    ).toEqual([]);
    expect(inputs.some((input) => input.endsWith('core/dist/chain.js'))).toBe(
      false
    );
    expect(inputs.filter((input) => input.includes('chain.js'))).toEqual([
      expect.stringContaining('workflow/chain.js'),
    ]);
  });
});
