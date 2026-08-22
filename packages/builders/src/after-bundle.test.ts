import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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

  protected override async createStepsBundle({ outfile }: { outfile: string }) {
    mkdirSync(dirname(outfile), { recursive: true });
    writeFileSync(
      outfile,
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
    options: {
      watch?: boolean;
      workingDir?: string;
      stepsPath?: string;
      workflowsPath?: string;
    } = {}
  ): TestBuilder {
    const workingDir = options.workingDir ?? testRoot;
    return new TestBuilder({
      buildTarget: 'standalone',
      workingDir,
      dirs: ['.'],
      watch: options.watch,
      stepsBundlePath: options.stepsPath ?? stepsPath,
      workflowsBundlePath: options.workflowsPath ?? workflowsPath,
      webhookBundlePath: join(workingDir, 'webhook.js'),
      onAfterBundle,
      suppressCreateManifestLogs: true,
    });
  }

  it('runs once with the three frozen, completed bundle artifacts', async () => {
    const onAfterBundle = vi.fn();
    const builder = createBuilder(onAfterBundle);
    const { manifest } = await builder.createTestBundle();

    await builder.createTestManifest(manifest, manifestDir);

    expect(onAfterBundle).toHaveBeenCalledOnce();
    expect(onAfterBundle).toHaveBeenCalledWith({
      buildTarget: 'standalone',
      workingDir: testRoot,
      artifacts: [
        { kind: 'steps', path: stepsPath },
        { kind: 'workflows', path: workflowsPath },
        { kind: 'manifest', path: join(manifestDir, 'manifest.json') },
      ],
    });

    const result = onAfterBundle.mock.calls[0][0];
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifacts)).toBe(true);
    expect(result.artifacts.every(Object.isFrozen)).toBe(true);

    const writtenManifest = JSON.parse(
      readFileSync(join(manifestDir, 'manifest.json'), 'utf-8')
    );
    expect(writtenManifest).toMatchObject({
      version: '1.0.0',
      workflows: {
        'src/workflow.ts': {
          run: {
            workflowId: 'workflow//src/workflow.ts//run',
            graph: { nodes: [], edges: [] },
          },
        },
      },
    });
  });

  it('runs after every successful watch rebuild', async () => {
    const onAfterBundle = vi.fn();
    const builder = createBuilder(onAfterBundle, { watch: true });
    const { bundleFinal, manifest } = await builder.createTestBundle();

    await builder.createTestManifest(manifest, manifestDir);
    await bundleFinal?.('export async function run() { return "updated"; }');
    await builder.createTestManifest(manifest, manifestDir);
    await builder.createTestManifest(manifest, manifestDir);

    expect(bundleFinal).toBeDefined();
    expect(onAfterBundle).toHaveBeenCalledTimes(2);
  });

  it('writes and reports relative artifact paths against workingDir', async () => {
    const onAfterBundle = vi.fn();
    const builder = createBuilder(onAfterBundle, {
      workingDir: relative(process.cwd(), testRoot),
      stepsPath: 'output/steps.js',
      workflowsPath: 'output/workflows.js',
    });
    const { manifest } = await builder.createTestBundle();

    await builder.createTestManifest(manifest, 'output/manifest');

    const result = onAfterBundle.mock.calls[0][0];
    expect(result).toEqual({
      buildTarget: 'standalone',
      workingDir: testRoot,
      artifacts: [
        { kind: 'steps', path: join(testRoot, 'output/steps.js') },
        { kind: 'workflows', path: join(testRoot, 'output/workflows.js') },
        {
          kind: 'manifest',
          path: join(testRoot, 'output/manifest/manifest.json'),
        },
      ],
    });
    expect(
      result.artifacts.every(({ path }: { path: string }) => existsSync(path))
    ).toBe(true);
  });

  it('is awaited and rejects the build when it throws', async () => {
    const error = new Error('registration failed');
    const onAfterBundle = vi.fn(async () => {
      await Promise.resolve();
      throw error;
    });
    const builder = createBuilder(onAfterBundle);
    const { manifest } = await builder.createTestBundle();

    await expect(
      builder.createTestManifest(manifest, manifestDir)
    ).rejects.toMatchObject({
      message: 'onAfterBundle hook failed',
      cause: error,
    });
    expect(existsSync(join(manifestDir, 'manifest.json'))).toBe(true);

    // The failed hook does not roll back the files or leave a completion token
    // that can invoke the same hook again without another bundle write.
    await expect(
      builder.createTestManifest(manifest, manifestDir)
    ).resolves.toEqual(expect.any(String));
    expect(onAfterBundle).toHaveBeenCalledOnce();
  });

  it('preserves a non-Error hook failure as the error cause', async () => {
    const builder = createBuilder(() => Promise.reject('registration failed'));
    const { manifest } = await builder.createTestBundle();

    await expect(
      builder.createTestManifest(manifest, manifestDir)
    ).rejects.toMatchObject({
      message: 'onAfterBundle hook failed',
      cause: 'registration failed',
    });
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

  it('invalidates an earlier completion when a rebuild fails', async () => {
    const onAfterBundle = vi.fn();
    const builder = createBuilder(onAfterBundle);
    const completedBundle = await builder.createTestBundle();

    await builder.createTestManifest(completedBundle.manifest, manifestDir);
    expect(onAfterBundle).toHaveBeenCalledOnce();

    const error = new Error('workflow rebuild failed');
    builder.failNextWorkflowBundle(error);
    await expect(builder.createTestBundle()).rejects.toBe(error);
    await builder.createTestManifest(completedBundle.manifest, manifestDir);

    expect(onAfterBundle).toHaveBeenCalledOnce();
  });
});
