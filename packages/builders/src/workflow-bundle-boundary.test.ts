import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import {
  getWorkflowReducers,
  getWorkflowRevivers,
} from '@workflow/core/serialization';
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
    code: string;
    rawBytes: number;
    chainBootstrapBytes: number;
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
    const { interimBundleMetafile, interimBundleText } =
      await builder.createWorkflowBundle(
        inputFile,
        config.workflowsBundlePath,
        discoveredEntries
      );

    expect(interimBundleMetafile).toBeDefined();
    const outputs = Object.values(interimBundleMetafile?.outputs ?? {});
    const chainBootstrapBytes = outputs.reduce(
      (total, output) =>
        total +
        Object.entries(output.inputs).reduce(
          (subtotal, [input, contribution]) =>
            /core\/dist\/(chain-ref|class-serialization|workflow\/(bootstrap|chain))\.js$/.test(
              input.replaceAll('\\', '/')
            )
              ? subtotal + contribution.bytesInOutput
              : subtotal,
          0
        ),
      0
    );
    return {
      inputs: Object.keys(interimBundleMetafile?.inputs ?? {}).map((input) =>
        input.replaceAll('\\', '/')
      ),
      serdeOnlyFiles: [...discoveredEntries.discoveredSerdeFiles].map((file) =>
        file.replaceAll('\\', '/')
      ),
      code: interimBundleText ?? '',
      rawBytes: new TextEncoder().encode(interimBundleText ?? '').byteLength,
      chainBootstrapBytes,
    };
  }

  function expectNoZodInputs(inputs: string[]): void {
    expect(
      inputs.filter((input) => input.includes('/node_modules/zod/'))
    ).toEqual([]);
  }

  it('initializes the Chain bootstrap in a minimal workflow', async () => {
    const { inputs, code, rawBytes, chainBootstrapBytes } = await buildWorkflow(
      `export async function minimal() { "use workflow"; return 1; }`
    );

    expectNoZodInputs(inputs);
    const sandbox = createContext({ console, TextEncoder, TextDecoder });
    Object.defineProperty(sandbox, Symbol.for('WORKFLOW_USE_STEP'), {
      value: () => () => {},
    });
    runInContext(code, sandbox);
    expect(
      runInContext(
        `globalThis[Symbol.for('workflow-class-registry')].has('class//workflow//Chain')`,
        sandbox
      )
    ).toBe(true);
    // Pin a generous ceiling on the intentional no-import pass-through cost;
    // the exact contribution is reported by the metafile when this fails.
    expect(chainBootstrapBytes).toBeGreaterThan(0);
    expect(chainBootstrapBytes).toBeLessThan(5_000);
    expect(rawBytes).toBeGreaterThan(chainBootstrapBytes);
    console.info(`Chain workflow bootstrap: ${chainBootstrapBytes} raw bytes`);
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

  it('uses and initializes the workflow-safe Chain export', async () => {
    const { inputs, serdeOnlyFiles, code } = await buildWorkflow(`
      import { Chain } from '@workflow/core';
      globalThis.__chainClass = Chain;

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

    const sandbox = createContext({ console, TextEncoder, TextDecoder });
    Object.defineProperty(sandbox, Symbol.for('WORKFLOW_USE_STEP'), {
      value: () => () => {},
    });
    runInContext(code, sandbox);
    const destinationGlobal = runInContext(`globalThis`, sandbox);
    const registered = runInContext(
      `globalThis[Symbol.for('workflow-class-registry')].get('class//workflow//Chain')`,
      sandbox
    );
    const workflowChain = runInContext(`globalThis.__chainClass`, sandbox);
    expect(registered).toBeTypeOf('function');
    expect(workflowChain).toBe(registered);

    const ref = {
      runId: 'wrun_test',
      stepId: 'step_1',
      slot: 'hslot_0',
      length: 2,
    };
    const revived = getWorkflowRevivers(destinationGlobal).Chain?.(ref);
    expect(revived).toBeInstanceOf(workflowChain);
    expect(revived.take(1).length).toBe(1);
    expect(() => revived.append(3)).toThrow('inside a step');
    expect(() => revived.toArray()).toThrow('inside a step');
    expect(getWorkflowReducers(destinationGlobal).Chain?.(revived)).toEqual(
      ref
    );
  });
});
