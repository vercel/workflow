import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorld = vi.fn();
const initDataDir = vi.fn();
const setWorld = vi.fn();
const workflowTransformPlugin = vi.fn((options) => ({
  name: 'workflow:transform',
  options,
}));
const createBaseBuilderConfig = vi.fn((config) => config);
const getInputFiles = vi.fn(async () => ['workflows/example.ts']);
const createCombinedBundle = vi.fn(async () => {});
const baseBuilderConfigs: unknown[] = [];

vi.mock('@workflow/builders', () => {
  class BaseBuilder {
    constructor(config: unknown) {
      baseBuilderConfigs.push(config);
    }

    async getInputFiles() {
      return getInputFiles();
    }

    async createCombinedBundle(args: unknown) {
      return createCombinedBundle(args);
    }
  }

  return {
    BaseBuilder,
    createBaseBuilderConfig,
  };
});

vi.mock('@workflow/core/runtime', () => ({
  setWorld,
}));

vi.mock('@workflow/rollup', () => ({
  workflowTransformPlugin,
}));

vi.mock('@workflow/world-local', () => ({
  createWorld,
  initDataDir,
}));

type WorkflowVitestModule = typeof import('./index.js');

let loadedModule: WorkflowVitestModule | undefined;
const tempDirs: string[] = [];

async function loadModule(): Promise<WorkflowVitestModule> {
  loadedModule ??= await import('./index.js');
  return loadedModule;
}

function createMockWorld() {
  const handlers = new Map<string, (req: Request) => Promise<Response>>();
  return {
    handlers,
    clear: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    registerHandler: vi.fn(
      (prefix: string, handler: (req: Request) => Promise<Response>) => {
        handlers.set(prefix, handler);
      }
    ),
    start: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  loadedModule = undefined;
  baseBuilderConfigs.length = 0;
  tempDirs.length = 0;
  delete process.env.VITEST_POOL_ID;
});

afterEach(async () => {
  if (loadedModule) {
    await loadedModule.teardownWorkflowTests();
  }
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('@workflow/vitest', () => {
  it('builds bundles and initializes data in custom directories', async () => {
    const { buildWorkflowTests } = await loadModule();
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'workflow-vitest-build-')
    );
    tempDirs.push(rootDir);
    const cwd = path.resolve('/repo/app');

    await buildWorkflowTests({ cwd, rootDir });

    expect(createBaseBuilderConfig).toHaveBeenCalledWith({
      workingDir: cwd,
      dirs: ['.'],
    });
    expect(baseBuilderConfigs).toHaveLength(1);
    expect(createCombinedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        stepsOutfile: path.join(
          rootDir,
          '.workflow-vitest',
          '__step_registrations.mjs'
        ),
        flowOutfile: path.join(rootDir, '.workflow-vitest', 'combined.mjs'),
        // Bundles are loaded directly by Node in the vitest worker, so
        // project-local step dependencies must be bundled inline (#2289).
        bundleTransitiveLocalStepDependencies: true,
      })
    );
    expect(initDataDir).toHaveBeenCalledWith(
      path.join(rootDir, '.workflow-data')
    );
  });

  it('sets up a local world with custom directories and recovery disabled', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'workflow-vitest-'));
    tempDirs.push(tmpDir);
    const outDir = path.join(tmpDir, 'bundles');
    const dataDir = path.join(tmpDir, 'data');
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, 'combined.mjs'),
      `export async function POST() { return Response.json({ bundle: 'combined' }); }`
    );

    process.env.VITEST_POOL_ID = '7';
    const mockWorld = createMockWorld();
    createWorld.mockReturnValue(mockWorld);

    const { setupWorkflowTests } = await loadModule();
    await setupWorkflowTests({
      dataDir,
      outDir,
    });

    expect(createWorld).toHaveBeenCalledWith({
      dataDir,
      recoverActiveRuns: false,
      tag: 'vitest-7',
    });
    expect(mockWorld.clear).toHaveBeenCalledTimes(1);
    // V2 only registers a single combined handler; the separate step route is gone.
    expect(mockWorld.registerHandler).toHaveBeenCalledTimes(1);
    expect(mockWorld.start).toHaveBeenCalledTimes(1);
    expect(mockWorld.registerHandler.mock.invocationCallOrder[0]).toBeLessThan(
      mockWorld.start.mock.invocationCallOrder[0]
    );
    expect(setWorld).toHaveBeenCalledWith(mockWorld);

    const combinedHandler = mockWorld.handlers.get('__wkf_workflow_');
    expect(combinedHandler).toBeDefined();
    expect(mockWorld.handlers.has('__wkf_step_')).toBe(false);

    const combinedResponse = await combinedHandler!(new Request('http://test'));
    expect(await combinedResponse.json()).toEqual({ bundle: 'combined' });
  });

  it('provides project-scoped directory options without mutating process env', async () => {
    const rootDir = path.resolve('/tmp/workflow-vitest-root');
    const dataDir = path.resolve('/tmp/workflow-vitest-data');
    const outDir = path.resolve('/tmp/workflow-vitest-out');
    const cwd = path.resolve('/repo/app');
    const provide = vi.fn();

    const { workflow } = await loadModule();
    const plugins = workflow({ rootDir, dataDir, outDir });

    const vitestPlugin = plugins[1] as any;
    expect(vitestPlugin.name).toBe('workflow:vitest');
    vitestPlugin.configureVitest({
      project: {
        config: { root: cwd },
        provide,
      },
    });

    expect(process.env.WORKFLOW_VITEST_CWD).toBeUndefined();
    expect(process.env.WORKFLOW_VITEST_ROOT_DIR).toBeUndefined();
    expect(process.env.WORKFLOW_VITEST_DATA_DIR).toBeUndefined();
    expect(process.env.WORKFLOW_VITEST_OUT_DIR).toBeUndefined();
    expect(provide).toHaveBeenCalledWith('__workflowVitestOptions', {
      cwd,
      rootDir,
      dataDir,
      outDir,
    });
    expect(workflowTransformPlugin).toHaveBeenCalledWith({
      exclude: [`${outDir}/`],
    });
  });

  it('builds from project-scoped options in global setup', async () => {
    const buildWorkflowTests = vi.fn(async () => {});
    vi.doMock('./index.js', () => ({
      buildWorkflowTests,
    }));

    const cwd = path.resolve('/repo/app');
    const rootDir = path.join(cwd, 'test-root');
    const dataDir = path.join(rootDir, '.workflow-data');
    const outDir = path.join(rootDir, '.workflow-vitest');

    const { setup } = await import('./global-setup.js');
    await setup({
      getProvidedContext: () => ({
        __workflowVitestOptions: {
          cwd,
          rootDir,
          dataDir,
          outDir,
        },
      }),
    } as any);

    expect(buildWorkflowTests).toHaveBeenCalledWith({
      cwd,
      rootDir,
      dataDir,
      outDir,
    });
  });

  it('sets up and tears down from project-scoped injected options', async () => {
    const afterAll = vi.fn();
    const setupWorkflowTests = vi.fn(async () => {});
    const teardownWorkflowTests = vi.fn(async () => {});

    const cwd = path.resolve('/repo/app');
    const rootDir = path.join(cwd, 'test-root');
    const dataDir = path.join(rootDir, '.workflow-data');
    const outDir = path.join(rootDir, '.workflow-vitest');

    vi.doMock('vitest', () => ({
      afterAll,
      inject: vi.fn(() => ({
        cwd,
        rootDir,
        dataDir,
        outDir,
      })),
    }));
    vi.doMock('./index.js', () => ({
      setupWorkflowTests,
      teardownWorkflowTests,
    }));

    await import('./setup-file.js');

    expect(setupWorkflowTests).toHaveBeenCalledWith({
      cwd,
      rootDir,
      dataDir,
      outDir,
    });
    expect(afterAll).toHaveBeenCalledTimes(1);

    const teardown = afterAll.mock.calls[0]?.[0];
    expect(teardown).toBeTypeOf('function');
    await teardown();
    expect(teardownWorkflowTests).toHaveBeenCalledTimes(1);
  });
});
