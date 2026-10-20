import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

/**
 * The builder prebuilds the QuickJS engine's baseline heap into the flow
 * route when the build selects that engine, so instances restore it
 * instead of evaluating the bundle to build it.
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

describe('prebuilt QuickJS baseline', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const outputDirs: string[] = [];

  afterEach(() => {
    for (const outputDir of outputDirs) {
      rmSync(outputDir, { recursive: true, force: true });
    }
    outputDirs.length = 0;
    delete process.env.WORKFLOW_QUICKJS_PREBUILT_BASELINE;
    delete process.env.WORKFLOW_VM;
  });

  async function buildRoute() {
    const outputDir = mkdtempSync(join(import.meta.dirname, '.qjs-baseline-'));
    outputDirs.push(outputDir);
    const inputFile = join(outputDir, 'workflow.ts');
    writeFileSync(
      inputFile,
      'export async function wf() { "use workflow"; return 1; }\n'
    );
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
    const { interimBundleText } = await new TestBuilder(
      config
    ).createWorkflowBundle(inputFile, config.workflowsBundlePath, {
      discoveredSteps: new Set(),
      discoveredWorkflows: new Set([inputFile]),
      discoveredSerdeFiles: new Set(),
    });
    return {
      route: readFileSync(config.workflowsBundlePath, 'utf8'),
      interimBundleText: interimBundleText as string,
    };
  }

  function prebuiltIn(route: string) {
    const match = route.match(/^const workflowQuickJSBaseline = (.*);$/m);
    return match ? JSON.parse(match[1]) : undefined;
  }

  it('is not emitted by default', async () => {
    const { route } = await buildRoute();
    expect(prebuiltIn(route)).toBeUndefined();
    expect(route).not.toContain('quickjsBaseline');
  });

  it('is emitted when the build selects the QuickJS engine', async () => {
    process.env.WORKFLOW_VM = 'quickjs';
    const { route, interimBundleText } = await buildRoute();
    const prebuilt = prebuiltIn(route);
    expect(prebuilt).toMatchObject({ v: 1 });
    expect(prebuilt.ineligible).toBeUndefined();
    expect(typeof prebuilt.data).toBe('string');
    // Keyed to the exact code the route hands the runtime.
    expect(prebuilt.codeDigest).toBe(
      createHash('sha256').update(interimBundleText).digest('hex')
    );
    expect(route).toContain('quickjsBaseline: workflowQuickJSBaseline');
  });

  it('can be forced off for a QuickJS build', async () => {
    process.env.WORKFLOW_VM = 'quickjs';
    process.env.WORKFLOW_QUICKJS_PREBUILT_BASELINE = '0';
    const { route } = await buildRoute();
    expect(prebuiltIn(route)).toBeUndefined();
  });
});
