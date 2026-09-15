import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import type { Storage } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';
import { createRun, updateRun } from '../test-helpers.js';

/**
 * `runs.waitForTerminalStatus` on world-local: the in-process terminal signal
 * plus its filesystem backstop poll (see `run-status-signal.ts`).
 */
describe('runs.waitForTerminalStatus (world-local)', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-status-wait-'));
    storage = createStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const newRun = () =>
    createRun(storage, {
      deploymentId: 'dpl_test',
      workflowName: 'test-workflow',
      input: new Uint8Array([1]),
    });

  const waitForTerminalStatus = () => {
    const wait = storage.runs.waitForTerminalStatus;
    if (!wait) throw new Error('world-local should implement the long poll');
    return wait;
  };

  /**
   * Run `fn` after `ms`, returning a promise for its completion — so a test
   * can await the write it triggered and not race the temp-dir cleanup.
   */
  const delayed = <T>(ms: number, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      setTimeout(() => fn().then(resolve, reject), ms);
    });

  it('returns an already-terminal run without waiting', async () => {
    const run = await newRun();
    await updateRun(storage, run.runId, 'run_started');
    await updateRun(storage, run.runId, 'run_completed', {
      output: new Uint8Array([2]),
    });

    const startedAt = Date.now();
    const waited = await waitForTerminalStatus()(run.runId, {
      timeoutMs: 30_000,
    });

    expect(waited.status).toBe('completed');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('resolves as soon as the run completes', async () => {
    const run = await newRun();
    await updateRun(storage, run.runId, 'run_started');

    const pending = waitForTerminalStatus()(run.runId, { timeoutMs: 30_000 });
    // Finish the run while the wait is parked, the way a workflow finishing in
    // another part of the same dev server would.
    const finishing = delayed(20, () =>
      updateRun(storage, run.runId, 'run_completed', {
        output: new Uint8Array([2]),
      })
    );

    const startedAt = Date.now();
    const waited = await pending;
    await finishing;

    expect(waited.status).toBe('completed');
    // Nowhere near the 30s budget: the signal (or its 100ms backstop) wakes
    // the wait, not the budget expiring.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('picks up a cancellation', async () => {
    const run = await newRun();
    await updateRun(storage, run.runId, 'run_started');

    const pending = waitForTerminalStatus()(run.runId, { timeoutMs: 30_000 });
    const cancelling = delayed(20, () =>
      updateRun(storage, run.runId, 'run_cancelled')
    );

    expect((await pending).status).toBe('cancelled');
    await cancelling;
  });

  it('returns the latest non-terminal snapshot when the budget expires', async () => {
    const run = await newRun();
    await updateRun(storage, run.runId, 'run_started');

    const startedAt = Date.now();
    const waited = await waitForTerminalStatus()(run.runId, { timeoutMs: 150 });

    // A timeout is a normal return, not an error.
    expect(waited.status).toBe('running');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
  });

  it('returns immediately without a budget', async () => {
    const run = await newRun();
    await updateRun(storage, run.runId, 'run_started');

    const startedAt = Date.now();
    expect((await waitForTerminalStatus()(run.runId)).status).toBe('running');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('stops early when the caller aborts', async () => {
    const run = await newRun();
    await updateRun(storage, run.runId, 'run_started');
    const controller = new AbortController();

    const pending = waitForTerminalStatus()(run.runId, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    expect((await pending).status).toBe('running');
  });

  it('fails like get for an unknown run', async () => {
    await expect(
      waitForTerminalStatus()('wrun_01JB0000000000000000000000', {
        timeoutMs: 30_000,
      })
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
  });
});
