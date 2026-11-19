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

/**
 * Windows does not remove a directory another handle has open, such as
 * another clear() listing it: it only marks it "delete pending", and until
 * that handle closes, listing or removing it again fails with EPERM, where
 * POSIX removes it at once. This models that rule for the legacy directories,
 * so tagged clear()s running side by side meet it on any OS, as they did on
 * the Windows runner. Every other file operation is the real one.
 */
const listing = new Map<string, number>();
const deletePending = new Set<string>();
let listings = 0;
/** Runs once a listing has read its entries, before it returns them. */
let afterListing: ((dir: string) => Promise<void>) | undefined;
const isLegacy = (dir: unknown) =>
  typeof dir === 'string' && dir.startsWith(dataDir + path.sep);
const deniedFor = (syscall: string, dir: string) =>
  Object.assign(
    new Error(`EPERM: operation not permitted, ${syscall} '${dir}'`),
    { code: 'EPERM', syscall, path: dir }
  );

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fs = { ...actual };
  fs.readdir = (async (dir: any, ...rest: any[]) => {
    if (!isLegacy(dir)) return actual.readdir(dir, ...(rest as [any]));
    if (deletePending.has(dir)) throw deniedFor('scandir', dir);
    listing.set(dir, (listing.get(dir) ?? 0) + 1);
    try {
      const entries = await actual.readdir(dir, ...(rest as [any]));
      await afterListing?.(dir);
      // Held open a moment, for longer by some calls than by others, as a
      // larger directory or a slower worker would be.
      await new Promise((resolve) => setTimeout(resolve, (listings++ % 4) * 5));
      return entries;
    } finally {
      const count = (listing.get(dir) ?? 1) - 1;
      if (count > 0) listing.set(dir, count);
      else {
        listing.delete(dir);
        // The last handle closed: the pending removal happens.
        if (deletePending.delete(dir)) await actual.rmdir(dir);
      }
    }
  }) as typeof actual.readdir;
  fs.rmdir = (async (dir: any, ...rest: any[]) => {
    if (!isLegacy(dir) || !listing.has(dir))
      return actual.rmdir(dir, ...(rest as [any]));
    if (deletePending.has(dir)) throw deniedFor('rmdir', dir);
    if ((await actual.readdir(dir)).length > 0) {
      throw Object.assign(
        new Error(`ENOTEMPTY: directory not empty, rmdir '${dir}'`),
        { code: 'ENOTEMPTY', syscall: 'rmdir', path: dir }
      );
    }
    // Removed for good if that listing ended meanwhile.
    if (listing.has(dir)) deletePending.add(dir);
    else await actual.rmdir(dir);
  }) as typeof actual.rmdir;
  return { ...fs, default: fs };
});

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'legacy-data-'));
});

afterEach(() => {
  closeAllDatabases();
  rmSync(dataDir, { recursive: true, force: true });
  afterListing = undefined;
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

it('clear()s of two tags listing a directory that holds a file of each remove it', async () => {
  mkdirSync(path.join(dataDir, 'runs'));
  writeFileSync(path.join(dataDir, 'runs', 'wrun_A.vitest-0.json'), '{}');
  writeFileSync(path.join(dataDir, 'runs', 'wrun_B.vitest-1.json'), '{}');
  // Both list `runs` before either deletes its file, so each sees the
  // other's file there and keeps the directory for it.
  const runsDir = path.join(dataDir, 'runs');
  let arrived = 0;
  let bothListed: () => void = () => {};
  const listed = new Promise<void>((resolve) => {
    bothListed = resolve;
  });
  afterListing = async (dir) => {
    if (dir !== runsDir) return;
    if (++arrived === 2) bothListed();
    await listed;
  };
  const worlds = ['vitest-0', 'vitest-1'].map((tag) =>
    createWorld({ dataDir, tag })
  );
  await Promise.all(worlds.map((world) => world.clear()));
  await Promise.all(worlds.map((world) => world.close?.()));
  expect(arrived).toBe(2);
  expect(exists('runs')).toBe(false);
});
