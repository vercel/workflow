import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from '../index.js';
import { initDataDir } from '../init.js';
import { runLayoutCli } from '../layout-cli.js';
import { createStorage } from '../storage.js';
import {
  createRun,
  createStep,
  permissionEnforcement,
  updateRun,
  updateStep,
} from '../test-helpers.js';
import {
  convertLayout,
  DataDirLayoutError,
  findStrayFlatFiles,
  initializeLayoutMarker,
  LAYOUT_MARKER_FILE,
  resetStoreLayoutState,
  resolveStoreLayout,
} from './layout.js';

/** Relative path -> sha256 of every file under `dir`, skipping `.layout/`. */
async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full);
    if (rel.split(path.sep)[0] === '.layout') continue;
    out[rel] = createHash('sha256')
      .update(await fs.readFile(full))
      .digest('hex');
  }
  return out;
}

/** `hashTree` with run-scoped paths lifted to the flat name they came from. */
function lifted(tree: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).map(([p, h]) => {
      const parts = p.split(path.sep);
      return parts.length === 3 &&
        (parts[0] === 'events' || parts[0] === 'steps')
        ? [path.join(parts[0], parts[2]), h]
        : [p, h];
    })
  );
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  );
}

async function readMarkerState(dataDir: string): Promise<string | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(dataDir, LAYOUT_MARKER_FILE), 'utf8')
    ).state;
  } catch {
    return null;
  }
}

async function seedRun(dataDir: string, tag?: string, stepIds = ['step_1']) {
  const storage = createStorage(dataDir, tag);
  const run = await createRun(storage, {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array([1, 2, 3]),
  });
  await updateRun(storage, run.runId, 'run_started');
  for (const [i, stepId] of stepIds.entries()) {
    await createStep(storage, run.runId, {
      stepId,
      stepName: 'my-step',
      input: new Uint8Array([i]),
    });
    await updateStep(storage, run.runId, stepId, 'step_started');
    await updateStep(storage, run.runId, stepId, 'step_completed', {
      result: new Uint8Array([i, i]),
    });
  }
  return run.runId;
}

async function snapshot(
  dataDir: string,
  runId: string,
  tag?: string,
  stepId = 'step_1'
) {
  const storage = createStorage(dataDir, tag);
  const events = await storage.events.list({
    runId,
    pagination: { limit: 1000, sortOrder: 'asc' },
    resolveData: 'all',
  });
  const steps = await storage.steps.list({
    runId,
    pagination: { limit: 1000, sortOrder: 'asc' },
    resolveData: 'all',
  });
  const step = await storage.steps.get(runId, stepId, { resolveData: 'all' });
  return { events: events.data, steps: steps.data, step };
}

/** A legacy (flat) data directory: version.txt, no layout marker. */
async function makeFlatStore(dataDir: string): Promise<void> {
  await fs.writeFile(
    path.join(dataDir, 'version.txt'),
    '@workflow/world-local@5.0.2\n'
  );
}

/** Register a holder for a live process other than this one. */
async function fakeOtherProcessHolder(dataDir: string, pid: number) {
  const dir = path.join(dataDir, '.layout', 'holders');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${os.hostname()}-${pid}-test.json`);
  await fs.writeFile(
    file,
    JSON.stringify({ pid, hostname: os.hostname(), startedAt: 'x' })
  );
  return file;
}

/** A pid that is certainly not running: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid as number;
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-test-'));
  await resetStoreLayoutState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetStoreLayoutState();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('choosing a layout', () => {
  it('a new data directory initialized by its owner is run-scoped', async () => {
    const fresh = path.join(dataDir, 'new');
    await initDataDir(fresh);
    expect(await readMarkerState(fresh)).toBe('run-scoped');
    const runId = await seedRun(fresh);
    expect(await exists(path.join(fresh, 'events', runId))).toBe(true);
    expect(await exists(path.join(fresh, 'steps', runId))).toBe(true);
  });

  it('an existing empty data directory with a version file stays flat', async () => {
    await makeFlatStore(dataDir);
    await fs.mkdir(path.join(dataDir, 'events'));
    await initDataDir(dataDir);
    expect(await readMarkerState(dataDir)).toBeNull();
    const runId = await seedRun(dataDir);
    expect(await exists(path.join(dataDir, 'events', runId))).toBe(false);
    const flat = await fs.readdir(path.join(dataDir, 'events'));
    expect(flat.every((f) => f.startsWith(`${runId}-`))).toBe(true);
  });

  it('a directory holding data but no version file stays flat', async () => {
    await fs.mkdir(path.join(dataDir, 'runs'));
    await fs.writeFile(path.join(dataDir, 'runs', 'wrun_X.json'), '{}');
    await initDataDir(dataDir);
    expect(await readMarkerState(dataDir)).toBeNull();
  });

  it('competing initializers agree on one marker', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => initializeLayoutMarker(dataDir))
    );
    expect(await readMarkerState(dataDir)).toBe('run-scoped');
    const leftovers = (await fs.readdir(dataDir)).filter((f) =>
      f.includes('.tmp.')
    );
    expect(leftovers).toEqual([]);
  });

  it('reading never creates the data directory or a marker', async () => {
    const missing = path.join(dataDir, 'missing');
    const storage = createStorage(missing);
    await expect(
      storage.events.list({ runId: 'wrun_NOPE', pagination: {} })
    ).resolves.toBeDefined();
    expect(await exists(missing)).toBe(false);

    await makeFlatStore(dataDir);
    await seedRun(dataDir);
    expect(await readMarkerState(dataDir)).toBeNull();
  });

  it('rejects a malformed marker instead of guessing a layout', async () => {
    await makeFlatStore(dataDir);
    await fs.writeFile(path.join(dataDir, LAYOUT_MARKER_FILE), '{oops');
    await expect(resolveStoreLayout(dataDir)).rejects.toMatchObject({
      code: 'MALFORMED_MARKER',
    });
    // It unregistered, so it does not block a later conversion.
    expect(await fs.readdir(path.join(dataDir, '.layout', 'holders'))).toEqual(
      []
    );
  });

  it('rejects a marker written by a newer release', async () => {
    await makeFlatStore(dataDir);
    await fs.writeFile(
      path.join(dataDir, LAYOUT_MARKER_FILE),
      JSON.stringify({ schema: 2, state: 'run-scoped' })
    );
    await expect(
      createStorage(dataDir).events.list({ runId: 'wrun_X', pagination: {} })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MARKER' });
  });
});

describe('legacy flat stores without conversion', () => {
  it('are read and written in place, with nothing moved', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    const before = await hashTree(dataDir);
    await resetStoreLayoutState();
    const snap = await snapshot(dataDir, runId);
    expect(snap.events.map((e) => e.eventType)).toEqual([
      'run_created',
      'run_started',
      'step_created',
      'step_started',
      'step_completed',
    ]);
    expect(await hashTree(dataDir)).toEqual(before);
    expect(await readMarkerState(dataDir)).toBeNull();
  });

  it('stay readable when writes fail as on a read-only mount', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    await fs.rm(path.join(dataDir, '.layout'), { recursive: true });
    const before = await hashTree(dataDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const erofs = () =>
      Promise.reject(
        Object.assign(new Error('EROFS: read-only file system'), {
          code: 'EROFS',
        })
      );
    vi.spyOn(fs, 'mkdir').mockImplementation(erofs);
    vi.spyOn(fs, 'writeFile').mockImplementation(erofs);
    vi.spyOn(fs, 'rename').mockImplementation(erofs);
    const snap = await snapshot(dataDir, runId);
    expect(snap.events).toHaveLength(5);
    expect(snap.step.status).toBe('completed');
    vi.restoreAllMocks();
    expect(await hashTree(dataDir)).toEqual(before);
    expect(await exists(path.join(dataDir, '.layout'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not writable'));
  });

  it.skipIf(!permissionEnforcement.write)(
    'stay readable when the data directory is really not writable',
    async () => {
      await makeFlatStore(dataDir);
      const runId = await seedRun(dataDir);
      await resetStoreLayoutState();
      await fs.rm(path.join(dataDir, '.layout'), { recursive: true });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await fs.chmod(dataDir, 0o555);
      try {
        const snap = await snapshot(dataDir, runId);
        expect(snap.events).toHaveLength(5);
      } finally {
        await fs.chmod(dataDir, 0o755);
      }
    }
  );
});

describe('migrate', () => {
  it('converts a flat store losslessly, tags included', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    const taggedRunId = await seedRun(dataDir, 'vitest-0');
    const before = await snapshot(dataDir, runId);
    const taggedBefore = await snapshot(dataDir, taggedRunId, 'vitest-0');
    const flatTree = await hashTree(dataDir);
    await resetStoreLayoutState();

    const report = await convertLayout(dataDir, 'run-scoped');
    expect(report).toMatchObject({
      completed: true,
      conflicts: [],
      liveHolders: [],
      moved: 12,
    });
    expect(await readMarkerState(dataDir)).toBe('run-scoped');
    const tree = await hashTree(dataDir);
    delete tree[LAYOUT_MARKER_FILE];
    expect(lifted(tree)).toEqual(flatTree);
    expect(await findStrayFlatFiles(dataDir)).toEqual([]);

    await resetStoreLayoutState();
    expect(await snapshot(dataDir, runId)).toEqual(before);
    expect(await snapshot(dataDir, taggedRunId, 'vitest-0')).toEqual(
      taggedBefore
    );
  });

  it('routes step ids containing the separator by the stored run id', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir, undefined, ['step_a-step_b']);
    const before = await snapshot(dataDir, runId, undefined, 'step_a-step_b');
    await resetStoreLayoutState();
    expect(await convertLayout(dataDir, 'run-scoped')).toMatchObject({
      completed: true,
      conflicts: [],
    });
    expect(await fs.readdir(path.join(dataDir, 'steps', runId))).toHaveLength(
      1
    );
    await resetStoreLayoutState();
    expect(await snapshot(dataDir, runId, undefined, 'step_a-step_b')).toEqual(
      before
    );
  });

  it('refuses while another live process has the store open, and changes nothing', async () => {
    await makeFlatStore(dataDir);
    await seedRun(dataDir);
    await resetStoreLayoutState();
    const before = await hashTree(dataDir);
    const holder = await fakeOtherProcessHolder(dataDir, process.ppid);

    const report = await convertLayout(dataDir, 'run-scoped');
    expect(report.completed).toBe(false);
    expect(report.liveHolders).toEqual([
      expect.objectContaining({ pid: process.ppid }),
    ]);
    expect(report.moved).toBe(0);
    expect(await readMarkerState(dataDir)).toBeNull();
    expect(await hashTree(dataDir)).toEqual(before);
    expect(await exists(holder)).toBe(true);
  });

  it('refuses while a process of this package that opened the store earlier is running', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    // Open the store in this process, then convert as if from another one:
    // the conversion only excludes the holder of the process running it.
    await createStorage(dataDir).events.list({ runId, pagination: {} });
    const [holder] = await fs.readdir(path.join(dataDir, '.layout', 'holders'));
    const renamed = path.join(dataDir, '.layout', 'holders', `other-${holder}`);
    await fs.rename(path.join(dataDir, '.layout', 'holders', holder), renamed);
    const report = await convertLayout(dataDir, 'run-scoped');
    expect(report.liveHolders).toHaveLength(1);
    expect(await readMarkerState(dataDir)).toBeNull();
  });

  it('ignores and removes holders of processes that are gone', async () => {
    await makeFlatStore(dataDir);
    await seedRun(dataDir);
    await resetStoreLayoutState();
    const holder = await fakeOtherProcessHolder(dataDir, deadPid());
    const report = await convertLayout(dataDir, 'run-scoped');
    expect(report.completed).toBe(true);
    expect(await exists(holder)).toBe(false);
  });

  it('a process opening the store mid-conversion is refused, not shown a partial log', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    let seen: unknown;
    await convertLayout(dataDir, 'run-scoped', {
      onBeforeMove: async () => {
        // The view of a process that starts now, after the marker went up.
        await resetStoreLayoutState();
        seen = await createStorage(dataDir)
          .events.list({ runId, pagination: {} })
          .catch((error) => error);
      },
    });
    expect(seen).toBeInstanceOf(DataDirLayoutError);
    expect(seen).toMatchObject({ code: 'CONVERSION_IN_PROGRESS' });
  });

  it('resumes after an interruption; the store stays closed until then', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir, undefined, ['step_1', 'step_2']);
    const before = await snapshot(dataDir, runId);
    await resetStoreLayoutState();

    const rename = fs.rename.bind(fs);
    let renames = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      // The 1st rename publishes the marker; crash a few file moves later.
      if (++renames === 4) throw new Error('simulated crash');
      return rename(from, to);
    });
    await expect(convertLayout(dataDir, 'run-scoped')).rejects.toThrow(
      'simulated crash'
    );
    vi.restoreAllMocks();
    expect(await readMarkerState(dataDir)).toBe('migrating');
    await expect(resolveStoreLayout(dataDir)).rejects.toMatchObject({
      code: 'CONVERSION_IN_PROGRESS',
    });

    const report = await convertLayout(dataDir, 'run-scoped');
    expect(report.completed).toBe(true);
    await resetStoreLayoutState();
    expect(await snapshot(dataDir, runId)).toEqual(before);
  });

  it('breaks a lock left by a conversion whose process is gone', async () => {
    await makeFlatStore(dataDir);
    await seedRun(dataDir);
    await resetStoreLayoutState();
    const lock = path.join(dataDir, '.layout', 'convert.lock');
    await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: deadPid(), hostname: os.hostname() })
    );
    expect((await convertLayout(dataDir, 'run-scoped')).completed).toBe(true);
  });

  it('drops identical leftovers and hard links; reports different files and stays closed', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    const flat = (await fs.readdir(path.join(dataDir, 'events'))).sort();
    const runEvents = path.join(dataDir, 'events', runId);
    await fs.mkdir(runEvents);
    // [0]: an identical copy already moved, [1]: hard-linked at both paths,
    // [2]: a different file at the destination.
    await fs.copyFile(
      path.join(dataDir, 'events', flat[0]),
      path.join(runEvents, flat[0])
    );
    await fs.link(
      path.join(dataDir, 'events', flat[1]),
      path.join(runEvents, flat[1])
    );
    await fs.writeFile(path.join(runEvents, flat[2]), '{"different":true}');
    const original2 = await fs.readFile(path.join(dataDir, 'events', flat[2]));

    const report = await convertLayout(dataDir, 'run-scoped');
    expect(report.dropped).toBe(2);
    expect(report.completed).toBe(false);
    expect(report.conflicts).toEqual([
      {
        path: path.join('events', flat[2]),
        reason: expect.stringContaining('different file already exists'),
      },
    ]);
    expect(await readMarkerState(dataDir)).toBe('migrating');
    // Both versions of the conflicting file are kept.
    expect(await fs.readFile(path.join(dataDir, 'events', flat[2]))).toEqual(
      original2
    );
    await expect(resolveStoreLayout(dataDir)).rejects.toMatchObject({
      code: 'CONVERSION_IN_PROGRESS',
    });

    const quarantined = await convertLayout(dataDir, 'run-scoped', {
      quarantine: true,
    });
    expect(quarantined).toMatchObject({ completed: true, quarantined: 1 });
    expect(
      await fs.readFile(
        path.join(dataDir, '.layout', 'quarantine', 'events', flat[2])
      )
    ).toEqual(original2);
  });

  it('reports a flat file whose run cannot be determined', async () => {
    await makeFlatStore(dataDir);
    await fs.mkdir(path.join(dataDir, 'steps'), { recursive: true });
    // Two separators and no parseable runId.
    const name = 'wrun_A-step_x-step_y.json';
    await fs.writeFile(path.join(dataDir, 'steps', name), '{');
    const report = await convertLayout(dataDir, 'run-scoped');
    expect(report.completed).toBe(false);
    expect(report.conflicts).toEqual([
      {
        path: path.join('steps', name),
        reason: expect.stringContaining('cannot determine its run'),
      },
    ]);
  });

  it('serializes conversions with a lock', async () => {
    await makeFlatStore(dataDir);
    await seedRun(dataDir);
    await resetStoreLayoutState();
    let second: unknown;
    const first = await convertLayout(dataDir, 'run-scoped', {
      onBeforeMove: async () => {
        second = await convertLayout(dataDir, 'run-scoped').catch((e) => e);
      },
    });
    expect(first.completed).toBe(true);
    expect(second).toMatchObject({ code: 'CONVERSION_BUSY' });
  });

  it('moves flat files an older release wrote after the conversion', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    await convertLayout(dataDir, 'run-scoped');
    // Emulate an older writer appending one event in the flat layout.
    const stray = `${runId}-evnt_99999999999999999999999999.json`;
    await fs.writeFile(
      path.join(dataDir, 'events', stray),
      JSON.stringify({ runId, eventId: 'evnt_99999999999999999999999999' })
    );
    expect(await findStrayFlatFiles(dataDir)).toEqual([
      path.join('events', stray),
    ]);
    const report = await convertLayout(dataDir, 'run-scoped');
    expect(report).toMatchObject({ completed: true, moved: 1 });
    expect(await findStrayFlatFiles(dataDir)).toEqual([]);
    expect(await exists(path.join(dataDir, 'events', runId, stray))).toBe(true);
  });
});

describe('flatten', () => {
  it('restores the flat layout byte for byte and removes the marker', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    const before = await snapshot(dataDir, runId);
    const flatTree = await hashTree(dataDir);
    await resetStoreLayoutState();
    await convertLayout(dataDir, 'run-scoped');

    const report = await convertLayout(dataDir, 'flat');
    expect(report).toMatchObject({ completed: true, conflicts: [] });
    expect(await readMarkerState(dataDir)).toBeNull();
    expect(await hashTree(dataDir)).toEqual(flatTree);
    expect(await exists(path.join(dataDir, 'events', runId))).toBe(false);
    await resetStoreLayoutState();
    expect(await snapshot(dataDir, runId)).toEqual(before);
  });

  it('keeps the marker and the store closed while a conflict remains', async () => {
    await initDataDir(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    const [name] = await fs.readdir(path.join(dataDir, 'events', runId));
    await fs.writeFile(path.join(dataDir, 'events', name), '{"other":1}');

    const report = await convertLayout(dataDir, 'flat');
    expect(report.completed).toBe(false);
    expect(report.conflicts).toHaveLength(1);
    expect(await readMarkerState(dataDir)).toBe('flattening');
    expect(await exists(path.join(dataDir, 'events', runId, name))).toBe(true);
    await expect(resolveStoreLayout(dataDir)).rejects.toMatchObject({
      code: 'CONVERSION_IN_PROGRESS',
    });
  });

  it('drops a scoped file hard-linked to its flat path', async () => {
    await initDataDir(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    const [name] = await fs.readdir(path.join(dataDir, 'events', runId));
    await fs.link(
      path.join(dataDir, 'events', runId, name),
      path.join(dataDir, 'events', name)
    );
    const report = await convertLayout(dataDir, 'flat');
    expect(report).toMatchObject({ completed: true, dropped: 1 });
  });
});

describe('clear()', () => {
  it('tagged clear on a flat store removes only that tag and converts nothing', async () => {
    await makeFlatStore(dataDir);
    const keep = await seedRun(dataDir);
    await seedRun(dataDir, 'vitest-0');
    const keepBefore = await snapshot(dataDir, keep);
    await createWorld({ dataDir, tag: 'vitest-0' }).clear();
    expect(await readMarkerState(dataDir)).toBeNull();
    const events = await fs.readdir(path.join(dataDir, 'events'));
    expect(events.every((f) => f.startsWith(`${keep}-`))).toBe(true);
    expect(await snapshot(dataDir, keep)).toEqual(keepBefore);
  });

  it('tagged clear on a run-scoped store walks only its runs', async () => {
    await initDataDir(dataDir);
    const keep = await seedRun(dataDir);
    const otherTag = await seedRun(dataDir, 'vitest-1');
    const gone = await seedRun(dataDir, 'vitest-0');
    const readdir = vi.spyOn(fs, 'readdir');
    await createWorld({ dataDir, tag: 'vitest-0' }).clear();
    const listed = readdir.mock.calls.map((c) => String(c[0]));
    expect(listed).not.toContain(path.join(dataDir, 'events', keep));
    expect(listed).not.toContain(path.join(dataDir, 'events', otherTag));
    vi.restoreAllMocks();
    expect(await exists(path.join(dataDir, 'events', gone))).toBe(false);
    expect(await exists(path.join(dataDir, 'steps', gone))).toBe(false);
    expect(await exists(path.join(dataDir, 'events', keep))).toBe(true);
    expect(await exists(path.join(dataDir, 'events', otherTag))).toBe(true);
  });

  it('untagged clear keeps the layout other processes are using', async () => {
    await makeFlatStore(dataDir);
    await seedRun(dataDir);
    await createWorld({ dataDir }).clear();
    expect(await readMarkerState(dataDir)).toBeNull();

    const scoped = path.join(dataDir, 'scoped');
    await initDataDir(scoped);
    await seedRun(scoped);
    await createWorld({ dataDir: scoped }).clear();
    expect(await readMarkerState(scoped)).toBe('run-scoped');
  });
});

describe('start()', () => {
  it('converts only when opted in', async () => {
    await makeFlatStore(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createWorld({ dataDir, recoverActiveRuns: false }).start?.();
    expect(await readMarkerState(dataDir)).toBeNull();

    await createWorld({
      dataDir,
      recoverActiveRuns: false,
      migrateLayout: true,
    }).start?.();
    expect(await readMarkerState(dataDir)).toBe('run-scoped');
    expect(await exists(path.join(dataDir, 'events', runId))).toBe(true);
    // The converting process switched to the new layout itself.
    expect((await snapshot(dataDir, runId)).events).toHaveLength(5);
  });

  it('keeps the flat layout when another process has the store open', async () => {
    await makeFlatStore(dataDir);
    await seedRun(dataDir);
    await resetStoreLayoutState();
    await fakeOtherProcessHolder(dataDir, process.ppid);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createWorld({
      dataDir,
      recoverActiveRuns: false,
      migrateLayout: true,
    }).start?.();
    expect(await readMarkerState(dataDir)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refused'));
  });

  it('warns about flat files in a run-scoped store', async () => {
    await initDataDir(dataDir);
    await fs.mkdir(path.join(dataDir, 'events'), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'events', 'wrun_OLD-evnt_1.json'),
      '{}'
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createWorld({ dataDir, recoverActiveRuns: false }).start?.();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(path.join('events', 'wrun_OLD-evnt_1.json'))
    );
  });
});

describe('workflow-local-layout', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        stdout: (s: string) => out.push(s),
        stderr: (s: string) => err.push(s),
      },
    };
  }

  it('migrates and flattens with diagnostics on stderr only', async () => {
    await makeFlatStore(dataDir);
    await seedRun(dataDir);
    await resetStoreLayoutState();
    const m = io();
    expect(await runLayoutCli(['migrate', dataDir], m.io)).toBe(0);
    expect(m.out).toEqual([]);
    expect(m.err.join('\n')).toMatch(/Converted .* to per-run directories/);

    const s = io();
    expect(await runLayoutCli(['status', dataDir], s.io)).toBe(0);
    expect(JSON.parse(s.out[0])).toMatchObject({ layout: 'run-scoped' });

    const f = io();
    expect(await runLayoutCli(['flatten', dataDir], f.io)).toBe(0);
    expect(f.out).toEqual([]);
    expect(await readMarkerState(dataDir)).toBeNull();
  });

  it('exits 1 when files are left in place and 3 when the store is in use', async () => {
    await initDataDir(dataDir);
    const runId = await seedRun(dataDir);
    await resetStoreLayoutState();
    const [name] = await fs.readdir(path.join(dataDir, 'events', runId));
    await fs.writeFile(path.join(dataDir, 'events', name), '{"other":1}');
    expect(await runLayoutCli(['flatten', dataDir], io().io)).toBe(1);

    await fakeOtherProcessHolder(dataDir, process.ppid);
    const busy = io();
    expect(await runLayoutCli(['flatten', dataDir], busy.io)).toBe(3);
    expect(busy.err.join('\n')).toContain(`pid ${process.ppid}`);
  });

  it('exits 2 on bad usage', async () => {
    expect(await runLayoutCli(['frobnicate', dataDir], io().io)).toBe(2);
    expect(await runLayoutCli(['migrate'], io().io)).toBe(2);
    expect(
      await runLayoutCli(['migrate', path.join(dataDir, 'nope')], io().io)
    ).toBe(2);
  });
});
