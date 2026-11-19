import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeAllDatabases } from './db/index.js';
import { createWorld } from './index.js';
import { createRun } from './test-helpers.js';

/**
 * `clear()` gives the space back. `@workflow/vitest` clears in every worker,
 * so a database left at its high-water mark (and a WAL holding the whole
 * deleted volume) would stay that large for good.
 */

let dataDir: string;

beforeEach(() => {
  // Connections kept open: on Windows world-local's tests otherwise open one
  // per operation, which makes this many large writes too slow. The
  // connection is closed before the directory is removed.
  vi.stubEnv('WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS', '1');
  dataDir = mkdtempSync(path.join(tmpdir(), 'clear-disk-'));
});

afterEach(() => {
  closeAllDatabases();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const sizeOf = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};
const diskUse = () =>
  sizeOf(path.join(dataDir, 'world.db')) +
  sizeOf(path.join(dataDir, 'world.db-wal'));

/** About 30 MiB of step payloads, across a few runs. */
async function fill(world: ReturnType<typeof createWorld>) {
  const payload = new Uint8Array(64 * 1024).fill(7);
  for (let r = 0; r < 4; r++) {
    const run = await createRun(world, {
      deploymentId: 'dep-1',
      workflowName: 'wf',
      input: new Uint8Array(),
    });
    for (let i = 0; i < 120; i++) {
      await world.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: `step_${i}`,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { stepName: 'add', input: payload },
      });
    }
  }
}

it.each([
  ['untagged', undefined],
  ['tagged', 'vitest-0'],
])(
  'a %s clear() returns the space to the file system',
  async (_, tag) => {
    const world = createWorld({ dataDir, tag });
    await fill(world);
    const before = diskUse();
    expect(before).toBeGreaterThan(25 * 1024 * 1024);

    await world.clear();
    await world.close?.();

    const after = diskUse();
    expect(after, `before: ${before}, after: ${after}`).toBeLessThan(
      before / 4
    );
  },
  60_000
);
