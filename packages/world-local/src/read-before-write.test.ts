import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createWorld } from './index.js';
import { createRun } from './test-helpers.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'read-before-write-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// The CLI and the web UI pointed at an app that has not run yet: reading
// must not create the app's data directory (or its database).
it('reads an absent data directory as empty, without creating it', async () => {
  const dataDir = path.join(base, '.workflow-data');
  const world = createWorld({ dataDir, queueAuthKey: 'read' });
  try {
    expect((await world.runs.list({})).data).toEqual([]);
    await expect(
      world.runs.get('wrun_01M6MV000000000000000000000')
    ).rejects.toThrow();
    expect((await world.hooks.list({})).data).toEqual([]);
    expect(existsSync(dataDir)).toBe(false);

    // The first write creates it.
    await createRun(world, {
      deploymentId: 'dep-1',
      workflowName: 'wf',
      input: new Uint8Array(),
    });
    expect(existsSync(path.join(dataDir, 'world.db'))).toBe(true);
    expect((await world.runs.list({})).data).toHaveLength(1);
  } finally {
    await world.close?.();
  }
});
