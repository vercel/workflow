import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

const discoveredEntries: DiscoveredEntries = {
  discoveredSteps: new Set(),
  discoveredWorkflows: new Set(),
  discoveredSerdeFiles: new Set(),
};

class TestBuilder extends BaseBuilder {
  readonly #stepsPath: string;
  readonly #workflowsPath: string;
  #workflowBundleError: Error | undefined;

  constructor(config: StandaloneConfig) {
    super(config);
    this.#stepsPath = config.stepsBundlePath;
    this.#workflowsPath = config.workflowsBundlePath;
  }

  async build(): Promise<void> {
    // no-op
  }

  protected override async createStepsBundle() {
    writeFileSync(
      this.#stepsPath,
      'export const __steps_registered = true;\n',
      'utf-8'
    );
    return {
      context: undefined,
      manifest: {
        steps: {
          'src/workflow.ts': {
            runStep: { stepId: 'step//src/workflow.ts//runStep' },
          },
        },
      },
    };
  }

  protected override async createWorkflowsBundle() {
    if (this.#workflowBundleError) {
      const error = this.#workflowBundleError;
      this.#workflowBundleError = undefined;
      throw error;
    }
    return {
      manifest: {
        workflows: {
          'src/workflow.ts': {
            run: { workflowId: 'workflow//src/workflow.ts//run' },
          },
        },
      },
      interimBundleText: 'export async function run() { return "ok"; }',
    };
  }

  public createTestBundle() {
    return this.createCombinedBundle({
      inputFiles: [],
      stepsOutfile: this.#stepsPath,
      flowOutfile: this.#workflowsPath,
      bundleFinalOutput: false,
      discoveredEntries,
    });
  }

  public failNextWorkflowBundle(error: Error): void {
    this.#workflowBundleError = error;
  }

  public createTestManifest(manifest: WorkflowManifest, manifestDir: string) {
    return this.createManifest({
      workflowBundlePath: this.#workflowsPath,
      manifestDir,
      manifest,
    });
  }
}

describe('onAfterBundle', () => {
  let testRoot: string;
  let workflowsPath: string;
  let stepsPath: string;
  let manifestDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'workflow-after-bundle-'));
    workflowsPath = join(testRoot, 'workflows.js');
    stepsPath = join(testRoot, 'steps.js');
    manifestDir = join(testRoot, 'manifest');
    mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  function createBuilder(
    onAfterBundle: NonNullable<StandaloneConfig['onAfterBundle']>,
    watch = false
  ): TestBuilder {
    return new TestBuilder({
      buildTarget: 'standalone',
      workingDir: testRoot,
      dirs: ['.'],
      watch,
      stepsBundlePath: stepsPath,
      workflowsBundlePath: workflowsPath,
      webhookBundlePath: join(testRoot, 'webhook.js'),
      onAfterBundle,
      suppressCreateManifestLogs: true,
    });
  }

  it('runs once with the completed bundle manifest and three artifacts', async () => {
    const onAfterBundle = vi.fn();
    const builder = createBuilder(onAfterBundle);
    const { manifest } = await builder.createTestBundle();

    await builder.createTestManifest(manifest, manifestDir);

    expect(onAfterBundle).toHaveBeenCalledOnce();
    expect(onAfterBundle).toHaveBeenCalledWith({
      buildTarget: 'standalone',
      workingDir: testRoot,
      workflowManifest: manifest,
      artifacts: [
        { kind: 'steps', path: stepsPath },
        { kind: 'workflows', path: workflowsPath },
        { kind: 'manifest', path: join(manifestDir, 'manifest.json') },
      ],
    });
  });

  it('runs after every successful watch rebuild', async () => {
    const onAfterBundle = vi.fn();
    const builder = createBuilder(onAfterBundle, true);
    const { bundleFinal, manifest } = await builder.createTestBundle();

    await builder.createTestManifest(manifest, manifestDir);
    await bundleFinal?.('export async function run() { return "updated"; }');
    await builder.createTestManifest(manifest, manifestDir);

    expect(bundleFinal).toBeDefined();
    expect(onAfterBundle).toHaveBeenCalledTimes(2);
  });

  it('reports the actual manifest path when manifestDir is relative', async () => {
    const onAfterBundle = vi.fn();
    const builder = createBuilder(onAfterBundle);
    const { manifest } = await builder.createTestBundle();
    const relativeManifestDir = relative(process.cwd(), manifestDir);

    await builder.createTestManifest(manifest, relativeManifestDir);

    expect(onAfterBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: expect.arrayContaining([
          { kind: 'manifest', path: join(manifestDir, 'manifest.json') },
        ]),
      })
    );
  });

  it('is awaited and rejects the build when it throws', async () => {
    const error = new Error('registration failed');
    const builder = createBuilder(async () => {
      await Promise.resolve();
      throw error;
    });
    const { manifest } = await builder.createTestBundle();

    await expect(
      builder.createTestManifest(manifest, manifestDir)
    ).rejects.toBe(error);
  });

  it('does not run for an incomplete or failed bundle', async () => {
    const onAfterBundle = vi.fn();
    const incompleteBuilder = createBuilder(onAfterBundle);
    const manifest: WorkflowManifest = {};

    writeFileSync(workflowsPath, '', 'utf-8');
    await incompleteBuilder.createTestManifest(manifest, manifestDir);

    const failedBuilder = createBuilder(onAfterBundle);
    const completedBundle = await failedBuilder.createTestBundle();
    rmSync(workflowsPath, { force: true });
    await failedBuilder.createTestManifest(
      completedBundle.manifest,
      manifestDir
    );

    expect(onAfterBundle).not.toHaveBeenCalled();
  });

  it('does not register artifacts when createCombinedBundle fails', async () => {
    const onAfterBundle = vi.fn();
    const builder = createBuilder(onAfterBundle);
    const error = new Error('workflow bundle failed');
    builder.failNextWorkflowBundle(error);

    await expect(builder.createTestBundle()).rejects.toBe(error);

    // A later manifest write for the same path must not turn the failed bundle
    // into an observable completion.
    writeFileSync(workflowsPath, '', 'utf-8');
    await builder.createTestManifest({}, manifestDir);

    expect(onAfterBundle).not.toHaveBeenCalled();
  });
});
