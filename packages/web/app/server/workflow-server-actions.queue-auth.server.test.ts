// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real createWorld, observed: the web UI's run actions act on a running
// app through its data directory, so its Local World must only read the
// app's queue auth key (see world-testing's queue-auth suite for the actions
// end to end against a running app).
vi.mock('@workflow/world-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/world-local')>();
  return { ...actual, createWorld: vi.fn(actual.createWorld) };
});

describe("the web UI's Local World", () => {
  let base: string;
  let createWorld: typeof import('@workflow/world-local').createWorld;
  let reenqueueRun: typeof import('./workflow-server-actions.server').reenqueueRun;

  // Loading the server actions module is most of this file's time: about 3s
  // alone, and far more on a loaded CI runner (it once took past 20s there).
  // It is loaded here, with its own budget, so the test's timeout covers
  // only the World creation and the check.
  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'web-queue-auth-'));
    vi.stubEnv('WORKFLOW_TARGET_WORLD', 'local');
    vi.stubEnv('WORKFLOW_LOCAL_DATA_DIR', path.join(base, '.workflow-data'));
    ({ createWorld } = await import('@workflow/world-local'));
    ({ reenqueueRun } = await import('./workflow-server-actions.server'));
  }, 120_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  // The module is already loaded: 20s is ample for creating the World and
  // the check, and still fails on a real slowdown.
  it(
    'only reads the queue auth key, and writes nothing into the data directory',
    {
      timeout: 20_000,
    },
    async () => {
      // Fails (no such run), after creating the World.
      await reenqueueRun({}, 'wrun_01M6MV000000000000000000000');

      expect(createWorld).toHaveBeenCalledWith({ queueAuthKey: 'read' });
      expect(existsSync(path.join(base, '.workflow-data'))).toBe(false);
    }
  );
});
