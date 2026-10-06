import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRunScopedLayoutCache } from '../src/storage/layout.js';
import { createStorage } from '../src/storage.js';
import { createRun, createStep, updateRun } from '../src/test-helpers.js';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const bench = path.join(scripts, 'benchmark-layout.mjs');
const flattenScript = path.join(scripts, 'flatten-layout.mjs');

/** Relative path -> sha256 of every file under `dir`. */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = createHash('sha256')
      .update(fs.readFileSync(full))
      .digest('hex');
  }
  return out;
}

function node(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

let root: string;
let store: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'world-local-scripts-'));
  store = path.join(root, 'store');
  fs.mkdirSync(path.join(store, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(store, 'events', 'wrun_A-evnt_1.json'),
    '{"runId":"wrun_A"}'
  );
  fs.writeFileSync(path.join(store, 'version.txt'), '5.0.1');
});

afterEach(async () => {
  resetRunScopedLayoutCache();
  await rm(root, { force: true, recursive: true });
});

describe('benchmark-layout prepare', () => {
  const prepare = (src: string, dst: string) =>
    node(bench, 'prepare', src, dst, '10');

  function expectRefused(
    result: ReturnType<typeof prepare>,
    pattern: RegExp
  ): void {
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(pattern);
  }

  it('refuses the same path and leaves the source intact', () => {
    const before = hashTree(store);
    expectRefused(prepare(store, store), /already exists/);
    expect(hashTree(store)).toEqual(before);
  });

  it('refuses an ancestor of the source', () => {
    const before = hashTree(root);
    expectRefused(prepare(store, root), /already exists|overlaps/);
    expect(hashTree(root)).toEqual(before);
  });

  it('refuses a new destination inside the source', () => {
    const before = hashTree(store);
    const dst = path.join(store, 'copy');
    expectRefused(prepare(store, dst), /overlaps/);
    expect(hashTree(store)).toEqual(before);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it('refuses a destination inside the source whose name starts with ..', () => {
    const before = hashTree(store);
    const dst = path.join(store, '..bench');
    expectRefused(prepare(store, dst), /overlaps/);
    expect(hashTree(store)).toEqual(before);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it('refuses a destination reached through a symlink to the source', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(store, alias);
    const before = hashTree(store);
    expectRefused(prepare(alias, path.join(alias, 'copy')), /overlaps/);
    expectRefused(prepare(store, alias), /already exists/);
    expect(hashTree(store)).toEqual(before);
  });

  it('refuses an existing destination and leaves both intact', () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');
    const before = { store: hashTree(store), other: hashTree(other) };
    expectRefused(prepare(store, other), /already exists/);
    expect({ store: hashTree(store), other: hashTree(other) }).toEqual(before);
  });

  it('copies into a new destination and pads it to the target', () => {
    const before = hashTree(store);
    const dst = path.join(root, 'bench');
    const result = prepare(store, dst);
    expect(result.status, result.stderr).toBe(0);
    expect(hashTree(store)).toEqual(before);
    expect(fs.readdirSync(path.join(dst, 'events'))).toHaveLength(10);
  });
});

describe('flatten-layout rollback', () => {
  it('restores the flat layout byte for byte, and the store reads the same after re-migrating', async () => {
    const dataDir = path.join(root, 'data');
    const storage = createStorage(dataDir);
    const run = await createRun(storage, {
      deploymentId: 'dep-1',
      workflowName: 'wf',
      input: new Uint8Array([1, 2, 3]),
    });
    await updateRun(storage, run.runId, 'run_started');
    await createStep(storage, run.runId, {
      stepId: 'step_0',
      stepName: 'my-step',
      input: new Uint8Array([0]),
    });
    const list = async () =>
      (
        await createStorage(dataDir).events.list({
          runId: run.runId,
          pagination: { limit: 1000, sortOrder: 'asc' },
          resolveData: 'all',
        })
      ).data;
    const eventsBefore = await list();
    const scoped = hashTree(dataDir);
    expect(
      Object.keys(scoped).some((p) =>
        p.startsWith(path.join('events', run.runId) + path.sep)
      )
    ).toBe(true);

    const result = node(flattenScript, dataDir);
    expect(result.status, result.stderr).toBe(0);

    // Every run-scoped file is now one level up, under the same name and bytes.
    const flat = hashTree(dataDir);
    const lifted = Object.fromEntries(
      Object.entries(scoped).map(([p, h]) => {
        const parts = p.split(path.sep);
        return parts.length === 3 &&
          (parts[0] === 'events' || parts[0] === 'steps')
          ? [path.join(parts[0], parts[2]), h]
          : [p, h];
      })
    );
    expect(flat).toEqual(lifted);
    expect(fs.existsSync(path.join(dataDir, 'events', run.runId))).toBe(false);

    // A new process migrates the flat files back and reads the same log.
    resetRunScopedLayoutCache();
    expect(await list()).toEqual(eventsBefore);
  });

  it('never overwrites a file already at the flat path', async () => {
    const dataDir = path.join(root, 'data');
    const runDir = path.join(dataDir, 'events', 'wrun_X');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'wrun_X-evnt_1.json'), 'scoped');
    fs.writeFileSync(
      path.join(dataDir, 'events', 'wrun_X-evnt_1.json'),
      'flat'
    );
    const before = hashTree(dataDir);
    const result = node(flattenScript, dataDir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/skipped/);
    expect(hashTree(dataDir)).toEqual(before);
  });
});
