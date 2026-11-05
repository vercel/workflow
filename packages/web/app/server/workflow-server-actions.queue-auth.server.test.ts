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

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'web-queue-auth-'));
    vi.stubEnv('WORKFLOW_TARGET_WORLD', 'local');
    vi.stubEnv('WORKFLOW_LOCAL_DATA_DIR', path.join(base, '.workflow-data'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('only reads the queue auth key, and writes nothing into the data directory', async () => {
    const { createWorld } = await import('@workflow/world-local');
    const { reenqueueRun } = await import('./workflow-server-actions.server');

    // Fails (no such run), after creating the World.
    await reenqueueRun({}, 'wrun_01M6MV000000000000000000000');

    expect(createWorld).toHaveBeenCalledWith({ queueAuthKey: 'read' });
    expect(existsSync(path.join(base, '.workflow-data'))).toBe(false);
  });
});
