import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

    if (!combinedHandler) {
      throw new Error('Expected combined handler to be registered');
    }

    const combinedResponse = await combinedHandler(new Request('http://test'));
    expect(await combinedResponse.json()).toEqual({ bundle: 'combined' });
  });

  it('provides project-scoped directory options without mutating process env', async () => {
    const rootDir = path.resolve('/tmp/workflow-vitest-root');
    const dataDir = path.resolve('/tmp/workflow-vitest-data');
    const outDir = path.resolve('/tmp/workflow-vitest-out');
    const cwd = path.resolve('/repo/app');

    const { workflow } = await loadModule();
    const plugins = workflow({ cwd, rootDir, dataDir, outDir });

    expect(workflowTransformPlugin).toHaveBeenCalledWith({
      exclude: [`${outDir}/`],
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

  it('derives project-scoped options from the Vite config root', async () => {
    const viteRoot = path.resolve('/repo/apps/api');

    const { workflow } = await loadModule();
    const plugins = workflow();

    const transformOptions = workflowTransformPlugin.mock.calls[0]?.[0] as {
      exclude: string[];
    };
    const vitestPlugin = plugins[1];
    const config = vitestPlugin.config?.({ root: viteRoot } as any) as {
      test: {
        provide: Record<string, unknown>;
      };
    };

    expect(config.test.provide.__workflowVitestOptions).toEqual({
      cwd: viteRoot,
      rootDir: viteRoot,
      dataDir: path.join(viteRoot, '.workflow-data'),
      outDir: path.join(viteRoot, '.workflow-vitest'),
    });
    expect(transformOptions.exclude).toContain(
      `${path.join(viteRoot, '.workflow-vitest')}/`
    );
  });

  it('updates project-scoped options from the resolved Vitest project root', async () => {
    const configRoot = path.resolve('/repo');
    const resolvedRoot = path.resolve('/repo/apps/api');
    const providedOptions: Record<string, unknown> = {};

    const { workflow } = await loadModule();
    const plugins = workflow();

    const transformOptions = workflowTransformPlugin.mock.calls[0]?.[0] as {
      exclude: string[];
    };
    const vitestPlugin = plugins[1];
    vitestPlugin.config?.({ root: configRoot } as any);
    (vitestPlugin as any).configureVitest?.({
      project: {
        config: {
          root: resolvedRoot,
        },
        provide: vi.fn((key: string, value: unknown) => {
          providedOptions[key] = value;
        }),
      } as any,
    });

    expect(providedOptions.__workflowVitestOptions).toEqual({
      cwd: resolvedRoot,
      rootDir: resolvedRoot,
      dataDir: path.join(resolvedRoot, '.workflow-data'),
      outDir: path.join(resolvedRoot, '.workflow-vitest'),
    });
    expect(transformOptions.exclude).toContain(
      `${path.join(resolvedRoot, '.workflow-vitest')}/`
    );
  });

  it('prefers explicit cwd over the Vite config root', async () => {
    const cwd = path.resolve('/repo/apps/api');
    const viteRoot = path.resolve('/repo');

    const { workflow } = await loadModule();
    const plugins = workflow({ cwd });

    const transformOptions = workflowTransformPlugin.mock.calls[0]?.[0] as {
      exclude: string[];
    };
    const vitestPlugin = plugins[1];
    const config = vitestPlugin.config?.({ root: viteRoot } as any) as {
      test: {
        provide: Record<string, unknown>;
      };
    };

    expect(config.test.provide.__workflowVitestOptions).toEqual({
      cwd,
      rootDir: cwd,
      dataDir: path.join(cwd, '.workflow-data'),
      outDir: path.join(cwd, '.workflow-vitest'),
    });
    expect(transformOptions.exclude).toEqual([
      `${path.join(cwd, '.workflow-vitest')}/`,
    ]);
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
    const fallbackCwd = path.resolve('/repo/wrong-app');

    const { setup } = await import('./global-setup.js');
    await setup({
      config: {
        provide: {
          __workflowVitestOptions: {
            cwd: fallbackCwd,
            rootDir: fallbackCwd,
            dataDir: path.join(fallbackCwd, '.workflow-data'),
            outDir: path.join(fallbackCwd, '.workflow-vitest'),
          },
        },
      },
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
