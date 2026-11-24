// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { World } from '@workflow/world';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real createWorld, observed so the test can close the World it made:
// it holds the data directory's database open, and Windows refuses to
// delete an open file.
const { worlds } = vi.hoisted(() => ({ worlds: [] as World[] }));
vi.mock('@workflow/world-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/world-local')>();
  return {
    ...actual,
    createWorld: vi.fn((...args: Parameters<typeof actual.createWorld>) => {
      const world = actual.createWorld(...args);
      worlds.push(world);
      return world;
    }),
  };
});

// No fakes: the real Local World and the real `start()`. No app is running,
// so the run stays pending and its deliveries fail in the background; what
// this checks is the run the web UI writes into the app's data directory.
describe('startWorkflowRun on a real Local World', () => {
  let project: string;
  let dataDir: string;
  let actions: typeof import('./workflow-server-actions.server');

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), 'web-start-real-'));
    dataDir = path.join(project, '.next', 'workflow-data');
    mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('WORKFLOW_TARGET_WORLD', 'local');
    vi.stubEnv('WORKFLOW_OBSERVABILITY_CWD', project);
    vi.stubEnv('WORKFLOW_LOCAL_DATA_DIR', undefined);
    // Nothing listens here, so no delivery reaches some other local app.
    vi.stubEnv('PORT', '1');
    actions = await import('./workflow-server-actions.server');
  }, 120_000);

  afterAll(async () => {
    // Also stops the background retries of the deliveries no app receives.
    await Promise.all(worlds.map((world) => world.close?.()));
    vi.unstubAllEnvs();
    rmSync(project, { recursive: true, force: true });
  });

  // The health check finds no app and waits out its 10s timeout.
  it(
    "writes a pending run into the app's data directory",
    { timeout: 30_000 },
    async () => {
      const workflowId = 'workflow//./workflows/order//processOrder';
      const started = await actions.startWorkflowRun({}, workflowId, [
        'order_123',
        { qty: 2 },
      ]);
      expect(started.success).toBe(true);
      if (!started.success) return;

      const fetched = await actions.fetchRun({}, started.data, 'none');
      expect(fetched.success).toBe(true);
      if (!fetched.success) return;
      expect(fetched.data).toMatchObject({
        runId: started.data,
        workflowName: workflowId,
        status: 'pending',
      });
      expect(fetched.data.specVersion).toEqual(expect.any(Number));

      // Written where the app reads, and nowhere else: no fallback directory,
      // and no queue auth key (the web UI only reads the app's).
      expect(readdirSync(dataDir)).toContain('world.db');
      expect(existsSync(path.join(dataDir, 'queue-auth-key'))).toBe(false);
      expect(existsSync(path.join(project, '.workflow-data'))).toBe(false);
    }
  );
});
