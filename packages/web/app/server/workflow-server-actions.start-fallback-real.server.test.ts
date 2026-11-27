// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { World } from '@workflow/world';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real createWorld, observed only so the test can close every World it
// made: each holds its data directory's database open, and Windows refuses to
// delete an open file.
const { worlds, closedDataDirs } = vi.hoisted(() => ({
  worlds: [] as World[],
  closedDataDirs: [] as (string | undefined)[],
}));
vi.mock('@workflow/world-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/world-local')>();
  return {
    ...actual,
    createWorld: vi.fn((...args: Parameters<typeof actual.createWorld>) => {
      const world = actual.createWorld(...args);
      const close = world.close?.bind(world);
      world.close = async () => {
        closedDataDirs.push(args[0]?.dataDir);
        await close?.();
      };
      worlds.push(world);
      return world;
    }),
  };
});

// No fakes: the real Local World and the real `start()`. The web UI usually
// opens on the Runs tab, so a World exists on the fallback directory before
// the app has created its own. A run started after the app's directory
// appears must land there, not in the fallback.
describe('startWorkflowRun after the app creates its data directory', () => {
  let project: string;
  let appDataDir: string;
  let fallbackDataDir: string;
  let actions: typeof import('./workflow-server-actions.server');
  let createWorld: typeof import('@workflow/world-local').createWorld;

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), 'web-start-fallback-'));
    appDataDir = path.join(project, '.next', 'workflow-data');
    fallbackDataDir = path.join(project, '.workflow-data');
    vi.stubEnv('WORKFLOW_TARGET_WORLD', 'local');
    vi.stubEnv('WORKFLOW_OBSERVABILITY_CWD', project);
    vi.stubEnv('WORKFLOW_LOCAL_DATA_DIR', undefined);
    // Nothing listens here, so no delivery reaches some other local app.
    vi.stubEnv('PORT', '1');
    actions = await import('./workflow-server-actions.server');
    ({ createWorld } = await import('@workflow/world-local'));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(worlds.map((world) => world.close?.()));
    vi.unstubAllEnvs();
    rmSync(project, { recursive: true, force: true });
  });

  // The health check finds no app and waits out its 10s timeout.
  it(
    "writes the run into the app's directory, not the fallback",
    { timeout: 40_000 },
    async () => {
      // The Runs tab: a World on the fallback, before the app has a directory.
      expect((await actions.fetchRuns({}, {})).success).toBe(true);

      const refused = await actions.startWorkflowRun({}, 'wf', []);
      expect(refused.success).toBe(false);

      // The app runs its first workflow and creates its directory.
      mkdirSync(appDataDir, { recursive: true });

      const workflowId = 'workflow//./workflows/order//processOrder';
      const started = await actions.startWorkflowRun({}, workflowId, [
        'order_123',
      ]);
      expect(started.success).toBe(true);
      if (!started.success) return;
      const { runId } = started.data;
      // The World left on the fallback was closed when the web UI moved off it.
      expect(closedDataDirs).toEqual([fallbackDataDir]);

      // Read each directory with its own World, as the app would.
      expect(existsSync(path.join(appDataDir, 'world.db'))).toBe(true);
      const app = createWorld({ dataDir: appDataDir, queueAuthKey: 'read' });
      await expect(
        app.runs.get(runId, { resolveData: 'none' })
      ).resolves.toMatchObject({ runId, workflowName: workflowId });

      if (existsSync(fallbackDataDir)) {
        const fallback = createWorld({
          dataDir: fallbackDataDir,
          queueAuthKey: 'read',
        });
        await expect(
          fallback.runs.get(runId, { resolveData: 'none' })
        ).rejects.toThrow();
      }
    }
  );
});
