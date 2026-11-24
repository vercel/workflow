// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { start, healthCheck, fakeWorld, dataDirsAtCreate } = vi.hoisted(() => ({
  start: vi.fn(),
  healthCheck: vi.fn(),
  dataDirsAtCreate: [] as (string | undefined)[],
  fakeWorld: {
    specVersion: 10,
    getDeploymentId: vi.fn(async () => 'dpl_local'),
  },
}));

vi.mock('@workflow/core/runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@workflow/core/runtime')>();
  return { ...actual, start };
});
vi.mock('@workflow/core/runtime/helpers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@workflow/core/runtime/helpers')>();
  return { ...actual, healthCheck };
});
vi.mock('@workflow/world-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/world-local')>();
  return {
    ...actual,
    createWorld: vi.fn(() => {
      dataDirsAtCreate.push(process.env.WORKFLOW_LOCAL_DATA_DIR);
      return fakeWorld;
    }),
  };
});

describe('startWorkflowRun', () => {
  let startWorkflowRun: typeof import('./workflow-server-actions.server').startWorkflowRun;

  // Loading the server actions module takes seconds; give it its own budget.
  beforeAll(async () => {
    ({ startWorkflowRun } = await import('./workflow-server-actions.server'));
  }, 120_000);

  beforeEach(() => {
    vi.stubEnv('WORKFLOW_TARGET_WORLD', 'local');
    vi.stubEnv('WORKFLOW_LOCAL_DATA_DIR', '/tmp/web-start-test-data');
    start.mockReset();
    healthCheck.mockReset();
    fakeWorld.getDeploymentId.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts a run with JSON args and returns its run ID', async () => {
    healthCheck.mockResolvedValue({ healthy: true, specVersion: 12 });
    start.mockResolvedValue({ runId: 'wrun_new' });

    const result = await startWorkflowRun({}, 'workflow//./w//order', [
      'order_123',
      { qty: 2 },
    ]);

    expect(result).toEqual({ success: true, data: 'wrun_new' });
    expect(healthCheck).toHaveBeenCalledWith(fakeWorld, {
      deploymentId: 'dpl_local',
      timeout: 10_000,
    });
    // Same call shape as the CLI's `workflow start`: the current deployment,
    // and the probed spec version capped at the World's.
    expect(start).toHaveBeenCalledWith(
      { workflowId: 'workflow//./w//order' },
      ['order_123', { qty: 2 }],
      { deploymentId: 'dpl_local', specVersion: 10, world: fakeWorld }
    );
  });

  it('leaves the spec version to start() when the health check fails', async () => {
    healthCheck.mockRejectedValue(new Error('timed out'));
    start.mockResolvedValue({ runId: 'wrun_new' });

    const result = await startWorkflowRun({}, 'wf', []);

    expect(result).toEqual({ success: true, data: 'wrun_new' });
    expect(start).toHaveBeenCalledWith({ workflowId: 'wf' }, [], {
      deploymentId: 'dpl_local',
      specVersion: undefined,
      world: fakeWorld,
    });
  });

  it.each([
    'vercel',
    '@workflow/world-vercel',
    '@workflow/world-postgres',
  ])('refuses the %s backend without starting a run', async (backend) => {
    vi.stubEnv('WORKFLOW_TARGET_WORLD', backend);

    const result = await startWorkflowRun({}, 'wf', []);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(
      'only supported on the local backend'
    );
    expect(result.error.request?.params).toEqual({ workflowId: 'wf' });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses arguments that are not an array', async () => {
    const result = await startWorkflowRun({}, 'wf', {
      not: 'an array',
    } as unknown as unknown[]);

    expect(result.success).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('wraps an error from start() with the workflow ID', async () => {
    healthCheck.mockResolvedValue({ healthy: true, specVersion: 10 });
    start.mockRejectedValue(new Error('No workflow named wf'));

    const result = await startWorkflowRun({}, 'wf', []);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('No workflow named wf');
    expect(result.error.request).toMatchObject({
      operation: 'startWorkflowRun',
      params: { workflowId: 'wf' },
    });
  });

  describe('before the app has a data directory', () => {
    let project: string;

    beforeEach(() => {
      project = mkdtempSync(path.join(tmpdir(), 'web-start-project-'));
      vi.stubEnv('WORKFLOW_OBSERVABILITY_CWD', project);
      // Not set by the user: the web UI discovers it.
      vi.stubEnv('WORKFLOW_LOCAL_DATA_DIR', undefined);
      dataDirsAtCreate.length = 0;
      healthCheck.mockResolvedValue({ healthy: true, specVersion: 10 });
      start.mockResolvedValue({ runId: 'wrun_new' });
    });

    afterEach(() => {
      rmSync(project, { recursive: true, force: true });
    });

    it('refuses with a clear error instead of starting a run the app never gets', async () => {
      const result = await startWorkflowRun({}, 'wf', []);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.message).toContain(
        "Couldn't find your app's workflow data directory"
      );
      expect(start).not.toHaveBeenCalled();
      expect(dataDirsAtCreate).toEqual([]);
    });

    it('starts on the app directory once it exists, without a restart', async () => {
      expect((await startWorkflowRun({}, 'wf', [])).success).toBe(false);

      // The app runs its first workflow and creates its data directory.
      const appDataDir = path.join(project, '.next', 'workflow-data');
      mkdirSync(appDataDir, { recursive: true });

      const result = await startWorkflowRun({}, 'wf', []);

      expect(result).toEqual({ success: true, data: 'wrun_new' });
      expect(dataDirsAtCreate.at(-1)).toBe(appDataDir);
      expect(process.env.WORKFLOW_LOCAL_DATA_DIR).toBe(appDataDir);
    });

    it('trusts a WORKFLOW_LOCAL_DATA_DIR the user set, even before it exists', async () => {
      const userDir = path.join(project, 'custom-data');
      vi.stubEnv('WORKFLOW_LOCAL_DATA_DIR', userDir);

      const result = await startWorkflowRun({}, 'wf', []);

      expect(result).toEqual({ success: true, data: 'wrun_new' });
      expect(dataDirsAtCreate.at(-1)).toBe(userDir);
    });
  });
});
