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
import { HookForceClaimedError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type Storage } from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHook, disposeHook } from '../test-helpers.js';
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

// Per-hook lock observation for the tests below (`holdNext`,
// `oneMoreQueued`): counts the tasks queued per key, and can park the next
// task queued on a key once it holds that key.
const locks = vi.hoisted(() => ({
  queued: new Map<string, number>(),
  hold: undefined as
    | { key: string; until: Promise<void>; onHeld: () => void }
    | undefined,
  waiters: [] as { key: string; count: number; resolve: () => void }[],
}));

vi.mock('../util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util.js')>();
  return {
    ...actual,
    withInProcessLock: <T>(
      lockMap: Map<string, Promise<unknown>>,
      key: string,
      fn: () => Promise<T>
    ) => {
      let run = fn;
      const hold = locks.hold;
      if (hold?.key === key) {
        locks.hold = undefined;
        run = async () => {
          hold.onHeld();
          await hold.until;
          return fn();
        };
      }
      // Enqueue first, so the takeover is already behind the parked resume
      // when the resume continues.
      const task = actual.withInProcessLock(lockMap, key, run);
      const queued = (locks.queued.get(key) ?? 0) + 1;
      locks.queued.set(key, queued);
      locks.waiters = locks.waiters.filter((waiter) => {
        if (waiter.key !== key || queued < waiter.count) return true;
        waiter.resolve();
        return false;
      });
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
  locks.queued.clear();
  locks.hold = undefined;
  locks.waiters = [];
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

/** Parks the next task queued on `key` once it holds the key. */
function holdNext(key: string) {
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    locks.hold = { key, until, onHeld: resolve };
  });
  return { held, release };
}

/** Resolves once one more task has queued on `key`. */
function oneMoreQueued(key: string): Promise<void> {
  const count = (locks.queued.get(key) ?? 0) + 1;
  return new Promise<void>((resolve) => {
    locks.waiters.push({ key, count, resolve });
  });
}

const hookLockKey = (runId: string, hookId: string) =>
  `${runId}-${hookId}.hook`;

function forceCreate(runId: string, hookId: string, token: string) {
  return storage.events.create(runId, {
    eventType: 'hook_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: hookId,
    eventData: { token, force: true },
  });
}

async function eventsOf(runId: string) {
  const { data } = await storage.events.list({ runId, pagination: {} });
  return data;
}

it('redirects a resume that queues behind the takeover to the new owner', async () => {
  const token = 'channel:redirect';
  const victim = await runningRun('victim');
  await createHook(storage, victim, { hookId: 'hook_victim', token });
  const claimer = await runningRun('claimer');
  const victimKey = hookLockKey(victim, 'hook_victim');

  const takeover = holdNext(victimKey);
  const claim = forceCreate(claimer, 'hook_claimer', token);
  await takeover.held;
  const resumeQueued = oneMoreQueued(victimKey);
  const refusal = storage.events
    .create(victim, {
      eventType: 'hook_received',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook_victim',
      eventData: { token, payload: new Uint8Array([1]) },
    })
    .then(
      () => undefined,
      (e: unknown) => e
    );
  await resumeQueued;
  takeover.release();

  expect((await claim).event.eventType).toBe('hook_created');
  const error = await refusal;
  expect(HookForceClaimedError.is(error)).toBe(true);
  expect(error).toMatchObject({
    token,
    claimedByRunId: claimer,
    claimedByHookId: 'hook_claimer',
  });
  expect((await eventsOf(victim)).map((e) => e.eventType)).toEqual([
    'run_created',
    'run_started',
    'hook_created',
    'hook_disposed',
  ]);
});

it('retries under the new holder when the holder changes before the claim lock', async () => {
  const token = 'channel:chain';
  const victim = await runningRun('victim');
  await createHook(storage, victim, { hookId: 'hook_victim', token });
  const first = await runningRun('first');
  const second = await runningRun('second');
  const victimKey = hookLockKey(victim, 'hook_victim');
  const firstKey = hookLockKey(first, 'hook_first');

  // `first` holds the victim's key; `second` read the same holder and queues
  // behind it, so by the time it holds the key the token belongs to `first`.
  const firstTakeover = holdNext(victimKey);
  const firstClaim = forceCreate(first, 'hook_first', token);
  await firstTakeover.held;
  const secondQueued = oneMoreQueued(victimKey);
  const secondClaim = forceCreate(second, 'hook_second', token);
  await secondQueued;
  const secondRetried = oneMoreQueued(firstKey);
  firstTakeover.release();

  expect((await firstClaim).event.eventType).toBe('hook_created');
  await secondRetried;
  expect((await secondClaim).event.eventType).toBe('hook_created');

  expect((await storage.hooks.getByToken(token)).hookId).toBe('hook_second');
  const victimDisposals = (await eventsOf(victim)).filter(
    (e) => e.eventType === 'hook_disposed'
  );
  expect(victimDisposals).toHaveLength(1);
  expect(victimDisposals[0].eventData).toMatchObject({
    forceClaimedBy: { runId: first, hookId: 'hook_first' },
  });
  const firstEvents = await eventsOf(first);
  expect(firstEvents.map((e) => e.eventType)).toEqual([
    'run_created',
    'run_started',
    'hook_created',
    'hook_disposed',
  ]);
  expect(firstEvents.at(-1)?.eventData).toMatchObject({
    forceClaimedBy: { runId: second, hookId: 'hook_second' },
  });
});

// The victim's own disposal holds its per-hook key and then takes the token
// claim lock. A takeover that took the claim lock before the victim's key
// would leave that disposal waiting out the claim lock's retry budget, far
// past this test's timeout.
it('lets the victim finish its own disposal while a takeover waits for its key', async () => {
  const token = 'channel:self-dispose';
  const victim = await runningRun('victim');
  await createHook(storage, victim, { hookId: 'hook_victim', token });
  const claimer = await runningRun('claimer');
  const victimKey = hookLockKey(victim, 'hook_victim');

  const disposal = holdNext(victimKey);
  const disposed = disposeHook(storage, victim, 'hook_victim');
  await disposal.held;
  const claimQueued = oneMoreQueued(victimKey);
  const claim = forceCreate(claimer, 'hook_claimer', token);
  await claimQueued;
  disposal.release();

  await disposed;
  const created = await claim;
  expect(created.event.eventType).toBe('hook_created');
  // The token was free by then: an ordinary claim, not a takeover.
  expect(created.event.eventData).not.toHaveProperty('forceClaimedFrom');
  expect((await storage.hooks.getByToken(token)).hookId).toBe('hook_claimer');
  const victimDisposals = (await eventsOf(victim)).filter(
    (e) => e.eventType === 'hook_disposed'
  );
  expect(victimDisposals).toHaveLength(1);
  expect(
    (victimDisposals[0].eventData as { forceClaimedBy?: unknown } | undefined)
      ?.forceClaimedBy
  ).toBeUndefined();
});
