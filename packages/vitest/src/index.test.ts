import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createLocalWorld = vi.fn();
const initDataDir = vi.fn();
const setWorld = vi.fn();
const workflowTransformPlugin = vi.fn((options) => ({
  name: 'workflow:transform',
  options,
}));
const createBaseBuilderConfig = vi.fn((config) => config);
const getInputFiles = vi.fn(async () => ['workflows/example.ts']);
const createWorkflowsBundle = vi.fn(async () => {});
const createStepsBundle = vi.fn(async () => {});
const baseBuilderConfigs: unknown[] = [];

vi.mock('@workflow/builders', () => {
  class BaseBuilder {
    constructor(config: unknown) {
      baseBuilderConfigs.push(config);
    }

    async getInputFiles() {
      return getInputFiles();
    }

    async createWorkflowsBundle(args: unknown) {
      return createWorkflowsBundle(args);
    }

    async createStepsBundle(args: unknown) {
      return createStepsBundle(args);
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
  createLocalWorld,
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
    expect(createWorkflowsBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        outfile: path.join(rootDir, '.workflow-vitest', 'workflows.mjs'),
      })
    );
    expect(createStepsBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        outfile: path.join(rootDir, '.workflow-vitest', 'steps.mjs'),
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
      path.join(outDir, 'workflows.mjs'),
      `export async function POST() { return Response.json({ bundle: 'workflow' }); }`
    );
    await writeFile(
      path.join(outDir, 'steps.mjs'),
      `export async function POST() { return Response.json({ bundle: 'step' }); }`
    );

    process.env.VITEST_POOL_ID = '7';
    const mockWorld = createMockWorld();
    createLocalWorld.mockReturnValue(mockWorld);

    const { setupWorkflowTests } = await loadModule();
    await setupWorkflowTests({
      dataDir,
      outDir,
    });

    expect(createLocalWorld).toHaveBeenCalledWith({
      dataDir,
      recoverActiveRuns: false,
      tag: 'vitest-7',
    });
    expect(mockWorld.clear).toHaveBeenCalledTimes(1);
    expect(mockWorld.registerHandler).toHaveBeenCalledTimes(2);
    expect(mockWorld.start).toHaveBeenCalledTimes(1);
    expect(mockWorld.registerHandler.mock.invocationCallOrder[1]).toBeLessThan(
      mockWorld.start.mock.invocationCallOrder[0]
    );
    expect(setWorld).toHaveBeenCalledWith(mockWorld);

    const workflowHandler = mockWorld.handlers.get('__wkf_workflow_');
    const stepHandler = mockWorld.handlers.get('__wkf_step_');
    expect(workflowHandler).toBeDefined();
    expect(stepHandler).toBeDefined();

    const workflowResponse = await workflowHandler!(new Request('http://test'));
    expect(await workflowResponse.json()).toEqual({ bundle: 'workflow' });

    const stepResponse = await stepHandler!(new Request('http://test'));
    expect(await stepResponse.json()).toEqual({ bundle: 'step' });
  });

  it('provides project-scoped directory options without mutating process env', async () => {
    const rootDir = path.resolve('/tmp/workflow-vitest-root');
    const dataDir = path.resolve('/tmp/workflow-vitest-data');
    const outDir = path.resolve('/tmp/workflow-vitest-out');
    const cwd = path.resolve('/repo/app');

    const { workflow } = await loadModule();
    const plugins = workflow({ cwd, rootDir, dataDir, outDir });

    expect(workflowTransformPlugin).toHaveBeenCalledWith({
      exclude: [outDir + '/'],
    });

    const vitestPlugin = plugins[1];
    expect(vitestPlugin.name).toBe('workflow:vitest');
    const config = vitestPlugin.config?.() as {
      test: {
        provide: Record<string, unknown>;
      };
    };

    expect(process.env.WORKFLOW_VITEST_CWD).toBeUndefined();
    expect(process.env.WORKFLOW_VITEST_ROOT_DIR).toBeUndefined();
    expect(process.env.WORKFLOW_VITEST_DATA_DIR).toBeUndefined();
    expect(process.env.WORKFLOW_VITEST_OUT_DIR).toBeUndefined();
    expect(config.test.provide.__workflowVitestOptions).toEqual({
      cwd,
      rootDir,
      dataDir,
      outDir,
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
      config: {
        provide: {
          __workflowVitestOptions: {
            cwd,
            rootDir,
            dataDir,
            outDir,
          },
        },
      },
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
