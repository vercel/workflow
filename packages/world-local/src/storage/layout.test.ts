import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';
import {
  createRun,
  createStep,
  updateRun,
  updateStep,
} from '../test-helpers.js';
import {
  migrateFlatRunScopedFiles,
  resetRunScopedLayoutCache,
} from './layout.js';

/**
 * Rewrite a run-scoped data directory into the flat layout every version
 * before it used: every file of `events/<runId>/` and `steps/<runId>/`
 * directly in `events/` and `steps/`, under the same name.
 */
async function flatten(dataDir: string): Promise<string[]> {
  const moved: string[] = [];
  for (const entityDir of ['events', 'steps']) {
    const root = path.join(dataDir, entityDir);
    for (const runDir of await fs.readdir(root)) {
      const full = path.join(root, runDir);
      if (!(await fs.stat(full)).isDirectory()) continue;
      for (const name of await fs.readdir(full)) {
        await fs.rename(path.join(full, name), path.join(root, name));
        moved.push(path.join(entityDir, name));
      }
      await fs.rmdir(full);
    }
  }
  return moved.sort();
}

/** Every file under `dir`, relative to it. */
async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(path.join(dir, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

async function seedRun(dataDir: string, tag?: string) {
  const storage = createStorage(dataDir, tag);
  const run = await createRun(storage, {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array([1, 2, 3]),
  });
  await updateRun(storage, run.runId, 'run_started');
  for (const i of [0, 1, 2]) {
    const stepId = `step_${i}`;
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

async function snapshot(dataDir: string, runId: string, tag?: string) {
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
  const step = await storage.steps.get(runId, 'step_1', {
    resolveData: 'all',
  });
  return { events: events.data, steps: steps.data, step };
}

describe('run-scoped layout migration', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-test-'));
    resetRunScopedLayoutCache();
  });

  afterEach(async () => {
    resetRunScopedLayoutCache();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('stores events and steps in one directory per run', async () => {
    const runId = await seedRun(dataDir);
    const files = await walk(dataDir);
    const eventFiles = files.filter((f) => f.startsWith(`events${path.sep}`));
    const stepFiles = files.filter((f) => f.startsWith(`steps${path.sep}`));
    expect(eventFiles.length).toBeGreaterThan(0);
    expect(stepFiles).toHaveLength(3);
    for (const f of [...eventFiles, ...stepFiles]) {
      expect(f.split(path.sep)[1]).toBe(runId);
    }
  });

  it('moves a flat store into per-run directories on first use, losslessly', async () => {
    const runA = await seedRun(dataDir);
    const runB = await seedRun(dataDir, 'vitest-0');
    const before = {
      a: await snapshot(dataDir, runA),
      b: await snapshot(dataDir, runB, 'vitest-0'),
    };
    const flatFiles = await flatten(dataDir);
    expect(flatFiles.length).toBeGreaterThan(20);
    // A write that crashed before its rename: not an entity file, stays put.
    const tmp = path.join(dataDir, 'events', `${runA}-evnt_x.json.tmp.01ABC`);
    await fs.writeFile(tmp, '{');

    // A fresh process: the first storage call converts the directory.
    resetRunScopedLayoutCache();
    expect(await snapshot(dataDir, runA)).toEqual(before.a);
    expect(await snapshot(dataDir, runB, 'vitest-0')).toEqual(before.b);

    const after = await walk(dataDir);
    for (const f of flatFiles) {
      const [entityDir, name] = f.split(path.sep);
      const runId = name.startsWith(runA) ? runA : runB;
      expect(after).toContain(path.join(entityDir, runId, name));
      expect(after).not.toContain(f);
    }
    await expect(fs.access(tmp)).resolves.toBeUndefined();

    // Writes after the move land in the run's directory and read back.
    const storage = createStorage(dataDir);
    await updateRun(storage, runA, 'run_completed', {
      output: new Uint8Array([9]),
    });
    const events = await storage.events.list({
      runId: runA,
      pagination: { limit: 1000 },
    });
    expect(events.data).toHaveLength(before.a.events.length + 1);
  });

  it('finishes a half-migrated store and is idempotent', async () => {
    const runId = await seedRun(dataDir);
    const before = await snapshot(dataDir, runId);
    const flatFiles = await flatten(dataDir);

    // Simulate a pass interrupted part-way: some files already moved, one
    // linked at both paths but not yet unlinked from the flat directory.
    const half = flatFiles.slice(0, Math.floor(flatFiles.length / 2));
    for (const f of half) {
      const [entityDir, name] = f.split(path.sep);
      await fs.mkdir(path.join(dataDir, entityDir, runId), { recursive: true });
      await fs.rename(
        path.join(dataDir, f),
        path.join(dataDir, entityDir, runId, name)
      );
    }
    const linked = flatFiles[half.length];
    {
      const [entityDir, name] = linked.split(path.sep);
      await fs.mkdir(path.join(dataDir, entityDir, runId), { recursive: true });
      await fs.link(
        path.join(dataDir, linked),
        path.join(dataDir, entityDir, runId, name)
      );
    }

    const first = await migrateFlatRunScopedFiles(dataDir);
    expect(first).toEqual({
      moved: flatFiles.length - half.length,
      skipped: 0,
    });
    expect(await migrateFlatRunScopedFiles(dataDir)).toEqual({
      moved: 0,
      skipped: 0,
    });
    resetRunScopedLayoutCache();
    expect(await snapshot(dataDir, runId)).toEqual(before);
  });

  it('never overwrites a different file already at the destination', async () => {
    const runId = await seedRun(dataDir);
    const flatFiles = await flatten(dataDir);
    const stepFile = flatFiles.find((f) => f.startsWith(`steps${path.sep}`))!;
    const name = path.basename(stepFile);
    const nested = path.join(dataDir, 'steps', runId, name);
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, '{"newer": true}');

    const result = await migrateFlatRunScopedFiles(dataDir);
    expect(result).toEqual({ moved: flatFiles.length - 1, skipped: 1 });
    expect(await fs.readFile(nested, 'utf8')).toBe('{"newer": true}');
    // The flat copy is left alone rather than deleted.
    await expect(
      fs.access(path.join(dataDir, stepFile))
    ).resolves.toBeUndefined();
  });

  it('is safe to run concurrently with itself', async () => {
    const runs = [await seedRun(dataDir), await seedRun(dataDir)];
    const before = await Promise.all(runs.map((r) => snapshot(dataDir, r)));
    const flatFiles = await flatten(dataDir);

    const passes = await Promise.all([
      migrateFlatRunScopedFiles(dataDir),
      migrateFlatRunScopedFiles(dataDir),
      migrateFlatRunScopedFiles(dataDir),
    ]);
    // Racing passes may each count a file they both finished moving.
    expect(passes.reduce((n, p) => n + p.moved, 0)).toBeGreaterThanOrEqual(
      flatFiles.length
    );
    expect(passes.every((p) => p.skipped === 0)).toBe(true);
    for (const entityDir of ['events', 'steps']) {
      const flatLeft = (
        await fs.readdir(path.join(dataDir, entityDir), { withFileTypes: true })
      ).filter((e) => e.isFile());
      expect(flatLeft).toEqual([]);
    }

    resetRunScopedLayoutCache();
    const after = await Promise.all(runs.map((r) => snapshot(dataDir, r)));
    expect(after).toEqual(before);
  });

  it('routes run ids containing dashes by their last entity-id prefix', async () => {
    const runId = 'wrun_custom-id-with-dashes';
    const eventsDir = path.join(dataDir, 'events');
    await fs.mkdir(eventsDir, { recursive: true });
    const name = `${runId}-evnt_000000000000000000000001.json`;
    await fs.writeFile(path.join(eventsDir, name), '{}');

    expect(await migrateFlatRunScopedFiles(dataDir)).toEqual({
      moved: 1,
      skipped: 0,
    });
    await expect(
      fs.access(path.join(eventsDir, runId, name))
    ).resolves.toBeUndefined();
  });
});
