import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Storage } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';
import {
  createRun,
  createStep,
  updateRun,
  updateStep,
} from '../test-helpers.js';
import {
  convertLayout,
  findStrayFlatFiles,
  resetStoreLayoutState,
} from './layout.js';

const require = createRequire(import.meta.url);
// The published 5.0.2 package, installed under an alias devDependency: the
// last release that writes the flat layout and knows nothing of layout.json.
const oldEntry = require.resolve('@workflow/world-local-5.0.2');
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
const project = (value: unknown) => JSON.parse(JSON.stringify(value));
async function setup() {
  const published = await import(pathToFileURL(oldEntry).href);
  const dir = await mkdtemp(path.join(tmpdir(), 'mixed-world-'));
  dirs.push(dir);
  const old: Storage & { start(): Promise<void>; close(): Promise<void> } =
    published.createWorld({ dataDir: dir, recoverActiveRuns: false });
  await old.start();
  closers.push(() => old.close());
  return { dir, old, current: createStorage(dir) };
}
async function begin(storage: Storage) {
  const run = await createRun(storage, {
    deploymentId: 'legacy-fixture',
    workflowName: 'mixed-version',
    input: new Uint8Array([1, 2]),
  });
  await updateRun(storage, run.runId, 'run_started');
  await createStep(storage, run.runId, {
    stepId: 'step_mixed',
    stepName: 'mixed',
    input: new Uint8Array([3]),
  });
  await updateStep(storage, run.runId, 'step_mixed', 'step_started', {
    attempt: 1,
  });
  return run.runId;
}
async function history(storage: Storage, runId: string) {
  return project(
    await storage.events.list({
      runId,
      resolveData: 'all',
      pagination: { limit: 100, sortOrder: 'asc' },
    })
  );
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await resetStoreLayoutState();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('published 5.0.2 writer with current reader', () => {
  it('does not move a live old writer history and round-trips explicit conversion', async () => {
    const { dir, old, current } = await setup();
    const runId = await begin(old);
    const files = await readdir(path.join(dir, 'events'));
    const first = await history(current, runId);
    expect(first.data).toHaveLength(4);
    expect(await history(old, runId)).toEqual(first);
    expect(await readdir(path.join(dir, 'events'))).toEqual(files);
    expect(await readdir(dir)).not.toContain('layout.json');
    await updateStep(old, runId, 'step_mixed', 'step_completed', {
      result: new Uint8Array([4]),
    });
    await updateRun(old, runId, 'run_completed', {
      output: new Uint8Array([5]),
    });
    const complete = await history(old, runId);
    expect(
      complete.data.map((e: { eventType: string }) => e.eventType)
    ).toEqual([
      'run_created',
      'run_started',
      'step_created',
      'step_started',
      'step_completed',
      'run_completed',
    ]);
    expect(await history(current, runId)).toEqual(complete);
    // Stop using the store, as the conversion requires.
    await resetStoreLayoutState();
    expect(await convertLayout(dir, 'run-scoped')).toMatchObject({
      completed: true,
      conflicts: [],
      moved: 7,
    });
    await resetStoreLayoutState();
    expect(await history(createStorage(dir), runId)).toEqual(complete);
    // Stop using the store, as the conversion requires.
    await resetStoreLayoutState();
    expect(await convertLayout(dir, 'flat')).toMatchObject({
      completed: true,
      conflicts: [],
    });
    expect(await readdir(dir)).not.toContain('layout.json');
    expect(await history(old, runId)).toEqual(complete);
  });

  it('detects and explicitly absorbs flat writes from an old writer after migration', async () => {
    const { dir, old } = await setup();
    await begin(old);
    // Stop using the store, as the conversion requires.
    await resetStoreLayoutState();
    expect((await convertLayout(dir, 'run-scoped')).completed).toBe(true);
    const runId = await begin(old);
    const strays = await findStrayFlatFiles(dir);
    expect(strays).toHaveLength(5);
    expect(strays.every((file) => file.includes(runId))).toBe(true);
    // Stop using the store, as the conversion requires.
    await resetStoreLayoutState();
    expect(await convertLayout(dir, 'run-scoped')).toMatchObject({
      completed: true,
      conflicts: [],
      moved: 5,
    });
    expect(await findStrayFlatFiles(dir)).toEqual([]);
    await resetStoreLayoutState();
    const events = await history(createStorage(dir), runId);
    expect(events.data.map((e: { eventType: string }) => e.eventType)).toEqual([
      'run_created',
      'run_started',
      'step_created',
      'step_started',
    ]);
  });
});
