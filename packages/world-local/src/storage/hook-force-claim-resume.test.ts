/**
 * A resume to a hook that is being force-claimed away from its run. The
 * resume checks the hook's dispose lock and then appends, under the hook's
 * per-hook lock; the takeover writes that dispose lock and the victim's
 * `hook_disposed{forceClaimedBy}`. If the takeover does not hold the victim's
 * per-hook lock, a resume that passed its check just before the takeover
 * lands its `hook_received` behind the disposal: the resumer is told it
 * succeeded, so it does not retry against the new owner, and the victim's
 * consumer has already finished at `hook_disposed`. The payload is lost.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT, type Storage } from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHook } from '../test-helpers.js';
import { createStorage } from './index.js';

// Parks the first `hook_received` at its promote, after both of its
// disposal checks. It is released when the takeover either queues behind it
// on the victim's per-hook lock, or (the bug) appends the victim's
// `hook_disposed` without waiting for it.
const gate = vi.hoisted(() => ({
  armed: false,
  parked: false,
  victimLockKey: '',
  notifyParked: () => {},
  release: () => {},
  released: Promise.resolve(),
}));

vi.mock('../fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs.js')>();
  return {
    ...actual,
    promoteExclusive: async (stagedPath: string, filePath: string) => {
      if (gate.armed) {
        gate.armed = false;
        gate.parked = true;
        gate.notifyParked();
        await gate.released;
      }
      return actual.promoteExclusive(stagedPath, filePath);
    },
    writeExclusive: async (filePath: string, content: string) => {
      const written = await actual.writeExclusive(filePath, content);
      if (
        gate.parked &&
        filePath.includes(`${path.sep}events${path.sep}`) &&
        JSON.parse(content).eventType === 'hook_disposed'
      ) {
        gate.release();
      }
      return written;
    },
  };
});

vi.mock('../util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util.js')>();
  return {
    ...actual,
    withInProcessLock: <T>(
      locks: Map<string, Promise<unknown>>,
      key: string,
      fn: () => Promise<T>
    ) => {
      // Enqueue first, so the takeover is already behind the parked resume
      // when the resume continues.
      const task = actual.withInProcessLock(locks, key, fn);
      if (gate.parked && key === gate.victimLockKey) {
        gate.release();
      }
      return task;
    },
  };
});

let testDir: string;
let storage: Storage;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-force-resume-'));
  storage = createStorage(testDir);
  gate.armed = false;
  gate.parked = false;
  gate.released = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
});

afterEach(async () => {
  gate.release();
  await fs.rm(testDir, { recursive: true, force: true });
});

async function runningRun(workflowName: string): Promise<string> {
  const { run } = await storage.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: `dpl_${workflowName}`,
      workflowName,
      input: new Uint8Array(),
    },
  });
  const runId = run?.runId;
  if (!runId) throw new Error('Expected run_created to return the run');
  await storage.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
  });
  return runId;
}

it('journals a resume that passed its disposal check before the forced disposal', async () => {
  const token = 'channel:handoff';
  const victim = await runningRun('victim');
  await createHook(storage, victim, { hookId: 'hook_victim', token });
  const claimer = await runningRun('claimer');

  gate.victimLockKey = `${victim}-hook_victim.hook`;
  const parked = new Promise<void>((resolve) => {
    gate.notifyParked = resolve;
  });
  gate.armed = true;
  const resume = storage.events.create(victim, {
    eventType: 'hook_received',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: 'hook_victim',
    eventData: { token, payload: new Uint8Array([1]) },
  });
  await parked;

  const claim = await storage.events.create(claimer, {
    eventType: 'hook_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: 'hook_claimer',
    eventData: { token, force: true },
  });
  expect(claim.event.eventType).toBe('hook_created');

  // The resume succeeded, so its payload must sit where the victim's
  // consumer still reads it: before the disposal.
  expect((await resume).event.eventType).toBe('hook_received');
  const { data } = await storage.events.list({
    runId: victim,
    pagination: {},
  });
  expect(data.map((e) => e.eventType)).toEqual([
    'run_created',
    'run_started',
    'hook_created',
    'hook_received',
    'hook_disposed',
  ]);
});
