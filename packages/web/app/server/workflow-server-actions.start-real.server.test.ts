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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// No mocks: the real Local World and the real `start()`. No app is running,
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

  afterAll(() => {
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
