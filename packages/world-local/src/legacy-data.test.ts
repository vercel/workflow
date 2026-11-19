import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeAllDatabases } from './db/index.js';
import { createWorld } from './index.js';
import { createStorage } from './storage.js';
import { createRun } from './test-helpers.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'legacy-data-'));
});

afterEach(() => {
  closeAllDatabases();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const newRun = (storage: ReturnType<typeof createStorage>) =>
  createRun(storage, {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array(),
  });

// Most apps never call world.start(), so the notice is tied to the first
// write after the upgrade, which creates world.db.
it('says once, when world.db is created next to the JSON data, that the earlier runs are no longer read', async () => {
  mkdirSync(path.join(dataDir, 'runs'));
  writeFileSync(path.join(dataDir, 'runs', 'wrun_A.json'), '{}');
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});

  await newRun(createStorage(dataDir));
  expect(info).toHaveBeenCalledTimes(1);
  expect(info.mock.calls[0][0]).toContain('no longer read');
  expect(info.mock.calls[0][0]).toContain(path.join(dataDir, 'runs'));

  // Reopening the database it created says nothing.
  closeAllDatabases();
  await newRun(createStorage(dataDir));
  expect(info).toHaveBeenCalledTimes(1);
});

it('says nothing in a data directory without JSON data', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  await newRun(createStorage(dataDir));
  expect(info).not.toHaveBeenCalled();
});

/** The JSON data an earlier release left, for two tags and none. */
function writeLegacyData() {
  const files = {
    untagged: [
      'runs/wrun_A.json',
      'steps/wrun_A/step_1.json',
      'events/wrun_A/evnt_1.json',
      'hooks/tokens/abc.json',
      'streams/chunks/s1/chnk_1.bin',
    ],
    tagged: [
      'runs/wrun_B.vitest-0.json',
      'steps/wrun_B/step_1.vitest-0.json',
      'events/wrun_B/evnt_1.vitest-0.json',
      'streams/chunks/s2/chnk_1.vitest-0.bin',
    ],
    otherTag: [
      'runs/wrun_C.vitest-1.json',
      'steps/wrun_C/step_1.vitest-1.json',
    ],
  };
  for (const file of Object.values(files).flat()) {
    mkdirSync(path.dirname(path.join(dataDir, file)), { recursive: true });
    writeFileSync(path.join(dataDir, file), '{"input":"secret"}');
  }
  return files;
}

const exists = (file: string) => existsSync(path.join(dataDir, file));

it('clear() deletes the run data of an earlier release too', async () => {
  writeLegacyData();
  const world = createWorld({ dataDir });
  await world.clear();
  await world.close?.();
  for (const dir of ['runs', 'steps', 'events', 'hooks', 'streams'])
    expect(exists(dir), dir).toBe(false);
});

it("a tagged clear() deletes only that tag's files of an earlier release", async () => {
  const files = writeLegacyData();
  const world = createWorld({ dataDir, tag: 'vitest-0' });
  await world.clear();
  await world.close?.();
  for (const file of files.tagged) expect(exists(file), file).toBe(false);
  for (const file of [...files.untagged, ...files.otherTag])
    expect(exists(file), file).toBe(true);
  // A directory only the tag's files were in goes with them.
  expect(exists('steps/wrun_B')).toBe(false);
  expect(exists('streams/chunks/s2')).toBe(false);
});

it('tagged clear()s running side by side do not trip over each other', async () => {
  const files = writeLegacyData();
  mkdirSync(path.join(dataDir, 'waits'));
  const worlds = ['vitest-0', 'vitest-1', 'vitest-2', 'vitest-3'].map((tag) =>
    createWorld({ dataDir, tag })
  );
  await Promise.all(worlds.map((world) => world.clear()));
  await Promise.all(worlds.map((world) => world.close?.()));
  for (const file of [...files.tagged, ...files.otherTag])
    expect(exists(file), file).toBe(false);
  for (const file of files.untagged) expect(exists(file), file).toBe(true);
});
