import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCreatedFilesCache } from './fs.js';
import { createWorld } from './index.js';
import { createStorage } from './storage.js';
import { createRun, createStep } from './test-helpers.js';

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-dir-guards-'));
  dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearCreatedFilesCache();
  await fs.rm(root, { recursive: true, force: true });
});

async function seedRun(tag?: string): Promise<string> {
  const storage = createStorage(dataDir, tag);
  const run = await createRun(storage, {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array(),
  });
  for (const stepId of ['step_1', 'step_2', 'step_3']) {
    await createStep(storage, run.runId, {
      stepId,
      stepName: 'step',
      input: new Uint8Array(),
    });
  }
  return run.runId;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('clear()', () => {
  it('a failed deletion rejects only after every started deletion finished', async () => {
    const kept = await seedRun();
    const cleared = await seedRun('vitest-0');
    const clearedDir = path.join(dataDir, 'events', cleared);
    const order: string[] = [];
    const paused = deferred();
    const resume = deferred();
    const unlink = fs.unlink.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'unlink').mockImplementation(async (p) => {
      if (typeof p === 'string' && path.dirname(p) === clearedDir) {
        const call = ++calls;
        if (call === 1) {
          paused.resolve();
          await resume.promise;
          await unlink(p);
          order.push('sibling-done');
          return;
        }
        if (call === 2) {
          order.push('failed');
          throw Object.assign(new Error('i/o error'), { code: 'EIO' });
        }
      }
      return unlink(p);
    });

    const clear = createWorld({ dataDir, tag: 'vitest-0' })
      .clear()
      .then(
        () => order.push('cleared'),
        (error) => order.push(`rejected:${error.code}`)
      );
    await paused.promise;
    // A bounded wait for something that must not happen: the rejection
    // surfacing while the first deletion is still held.
    for (let i = 0; i < 20 && order.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(order).toEqual(['failed']);
    resume.resolve();
    await clear;

    expect(order).toEqual(['failed', 'sibling-done', 'rejected:EIO']);
    expect(await fs.readdir(path.join(dataDir, 'events', kept))).toHaveLength(
      4
    );
  });
});

describe('run directories', () => {
  it('refuses to write through a symlinked run directory', async () => {
    const runId = await seedRun();
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const stepsDir = path.join(dataDir, 'steps', runId);
    await fs.rm(stepsDir, { recursive: true });
    await fs.symlink(outside, stepsDir, 'dir');
    clearCreatedFilesCache();

    await expect(
      createStep(createStorage(dataDir), runId, {
        stepId: 'step_4',
        stepName: 'step',
        input: new Uint8Array(),
      })
    ).rejects.toThrow(/symlinked run directory/);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
