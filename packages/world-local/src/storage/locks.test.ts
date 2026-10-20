/**
 * Native concurrency locks on the Local World: the shared conformance suite
 * (each test on a fresh data directory, with a second storage instance on
 * the same directory standing in for a second process), plus the
 * world-local-specific crash repair.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AnyEventRequest,
  type EventResult,
  SPEC_VERSION_CURRENT,
  type Storage,
} from '@workflow/world';
import { afterAll, describe, expect, test } from 'vitest';
import { lockConformance } from '../../../world/src/test-support/lock-conformance.js';
import { createWorld } from '../index.js';
import { createStorage } from '../storage.js';

// A short grace and a small cap, so the waitlist conformance can reach both.
// Read by the World per write.
const fifo = { graceMs: 300, waitlistCap: 20 };
process.env.WORKFLOW_LOCK_GRANT_GRACE_MS = String(fifo.graceMs);
process.env.WORKFLOW_LOCK_WAITLIST_CAP = String(fifo.waitlistCap);

const dirs: string[] = [];
const dirOf = new WeakMap<object, string>();
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function storageFor(events: Storage['events']) {
  const dir = dirOf.get(events);
  if (!dir) throw new Error('unknown events storage');
  return createStorage(dir);
}

lockConformance({
  name: 'world-local',
  events: () => {
    const dir = freshDir('wl-locks-');
    const { events } = createStorage(dir);
    dirOf.set(events, dir);
    return events;
  },
  secondEvents: (first) => storageFor(first).events,
  locks: (events) => storageFor(events).locks,
  capabilities: () =>
    createWorld({ dataDir: freshDir('wl-locks-caps-') }).capabilities,
  newRunId: () => null,
  // WORKFLOW_LOCKS_FIFO=0 runs the stage-1 suite alone.
  fifo: createWorld({ dataDir: freshDir('wl-locks-caps-') }).capabilities?.locks
    ?.fifo
    ? fifo
    : undefined,
});

describe('stage-1 lock files on a FIFO World', () => {
  test('a key written without the waitlist keeps working once it queues', async () => {
    const dir = freshDir('wl-locks-stage1-');
    const { events, locks } = createStorage(dir);
    const create = events.create as (
      runId: string | null,
      data: AnyEventRequest
    ) => Promise<EventResult>;
    const newRun = async () => {
      const { run } = await create(null, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'w',
          input: new Uint8Array([1]),
        },
      } as AnyEventRequest);
      const runId = run?.runId as string;
      await create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      } as AnyEventRequest);
      return runId;
    };
    const acquire = (runId: string, correlationId: string) =>
      create(runId, {
        eventType: 'lock_created',
        correlationId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { key: 'k', concurrency: 1 },
      } as AnyEventRequest);

    // The holder's grant is written by a stage-1 World: no waitlist fields.
    const holder = await newRun();
    process.env.WORKFLOW_LOCKS_FIFO = '0';
    try {
      expect((await acquire(holder, 'lock_h')).event?.eventType).toBe(
        'lock_acquired'
      );
    } finally {
      delete process.env.WORKFLOW_LOCKS_FIFO;
    }
    const stage1 = await locks?.get('k');
    expect(stage1?.queuedCount).toBeUndefined();

    const waiter = await newRun();
    expect((await acquire(waiter, 'lock_w')).lock?.waiter).toBe('queued');
    const released = await create(holder, {
      eventType: 'lock_released',
      correlationId: 'lock_h',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { key: 'k' },
    } as AnyEventRequest);
    expect(released.lockHandoffs?.map((h) => h.correlationId)).toEqual([
      'lock_w',
    ]);
    expect((await acquire(waiter, 'lock_w')).event?.eventType).toBe(
      'lock_acquired'
    );
    expect(await locks?.get('k')).toMatchObject({
      count: 1,
      queuedCount: 0,
      reservedCount: 0,
    });
  });
});
