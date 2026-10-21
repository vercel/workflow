/**
 * Native concurrency locks on the Local World: the shared conformance suite
 * (each test on a fresh data directory, with a second storage instance on
 * the same directory standing in for a second process), plus the
 * world-local-specific crash repair.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // WORKFLOW_LOCKS_FIFO=0 runs the polling suite alone.
  fifo: createWorld({ dataDir: freshDir('wl-locks-caps-') }).capabilities?.locks
    ?.fifo
    ? fifo
    : undefined,
});

describe('lock files written with WORKFLOW_LOCKS_FIFO=0, on a FIFO World', () => {
  test('a key written without the waitlist keeps working once it queues', async () => {
    const dir = freshDir('wl-locks-polling-');
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

    // The holder's grant is written without the waitlist: no waitlist fields.
    const holder = await newRun();
    process.env.WORKFLOW_LOCKS_FIFO = '0';
    try {
      expect((await acquire(holder, 'lock_h')).event?.eventType).toBe(
        'lock_acquired'
      );
    } finally {
      delete process.env.WORKFLOW_LOCKS_FIFO;
    }
    const polling = await locks?.get('k');
    expect(polling?.queuedCount).toBeUndefined();

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

describe('lock write crash repair and in-band accounting', () => {
  function setup(prefix: string) {
    const dir = freshDir(prefix);
    const { events } = createStorage(dir);
    const create = events.create as (
      runId: string | null,
      data: AnyEventRequest,
      params?: Record<string, unknown>
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
    const lockCreated = (correlationId: string) =>
      ({
        eventType: 'lock_created',
        correlationId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { key: 'k', concurrency: 1 },
      }) as AnyEventRequest;
    const lockEvents = async (runId: string, correlationId: string) =>
      (await events.list({ runId, pagination: { limit: 1000 } })).data
        .filter((e) => e.correlationId === correlationId)
        .map((e) => e.eventType);
    /**
     * Leaves the scope as a crash between publishing `eventType` and
     * recording it would: the event is in the log, the scope names none.
     */
    const forgetRecorded = (
      runId: string,
      correlationId: string,
      eventType:
        | 'lock_created'
        | 'lock_acquired'
        | 'lock_failed'
        | 'lock_released',
      field:
        | 'createdEventId'
        | 'acquiredEventId'
        | 'failedEventId'
        | 'releasedEventId'
    ) => {
      const file = path.join(
        dir,
        'locks',
        'scopes',
        runId,
        `${correlationId}.json`
      );
      const scope = JSON.parse(readFileSync(file, 'utf8'));
      delete scope[field];
      scope.publishing = eventType;
      writeFileSync(file, JSON.stringify(scope));
    };
    const lockReleased = (correlationId: string) =>
      ({
        eventType: 'lock_released',
        correlationId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { key: 'k' },
      }) as AnyEventRequest;
    return {
      events,
      create,
      newRun,
      lockCreated,
      lockReleased,
      lockEvents,
      forgetRecorded,
    };
  }

  test('a grant published but not recorded is not published again', async () => {
    const t = setup('wl-locks-crash-acquired-');
    const runId = await t.newRun();
    const first = await t.create(runId, t.lockCreated('lock_a'));
    expect(first.event?.eventType).toBe('lock_acquired');
    t.forgetRecorded(runId, 'lock_a', 'lock_acquired', 'acquiredEventId');

    const retried = await t.create(runId, t.lockCreated('lock_a'));
    expect(retried.event?.eventId).toBe(first.event?.eventId);
    expect(await t.lockEvents(runId, 'lock_a')).toEqual(['lock_acquired']);
  });

  test('a wait published but not recorded is not published again', async () => {
    const t = setup('wl-locks-crash-created-');
    const holder = await t.newRun();
    expect(
      (await t.create(holder, t.lockCreated('lock_h'))).event?.eventType
    ).toBe('lock_acquired');
    const runId = await t.newRun();
    const first = await t.create(runId, t.lockCreated('lock_w'));
    expect(first.event?.eventType).toBe('lock_created');
    t.forgetRecorded(runId, 'lock_w', 'lock_created', 'createdEventId');

    const retried = await t.create(runId, t.lockCreated('lock_w'));
    expect(retried.event?.eventId).toBe(first.event?.eventId);
    expect(await t.lockEvents(runId, 'lock_w')).toEqual(['lock_created']);
  });

  test('a refusal published but not recorded stays refused once a slot frees', async () => {
    const t = setup('wl-locks-crash-failed-');
    process.env.WORKFLOW_LOCK_WAITLIST_CAP = '1';
    try {
      const holder = await t.newRun();
      await t.create(holder, t.lockCreated('lock_h'));
      const queued = await t.newRun();
      expect(
        (await t.create(queued, t.lockCreated('lock_q'))).lock?.waiter
      ).toBe('queued');
      const refused = await t.newRun();
      const first = await t.create(refused, t.lockCreated('lock_r'));
      expect(first.event?.eventType).toBe('lock_failed');
      t.forgetRecorded(refused, 'lock_r', 'lock_failed', 'failedEventId');

      // Free the key entirely: the holder releases, the queued scope claims
      // its handoff and releases too.
      await t.create(holder, t.lockReleased('lock_h'));
      await t.create(queued, t.lockCreated('lock_q'));
      await t.create(queued, t.lockReleased('lock_q'));

      const retried = await t.create(refused, t.lockCreated('lock_r'));
      expect(retried.lock?.status).toBe('failed');
      expect(await t.lockEvents(refused, 'lock_r')).toEqual(['lock_failed']);
    } finally {
      delete process.env.WORKFLOW_LOCK_WAITLIST_CAP;
    }
  });

  test('a withdrawal published but not recorded is not queued again', async () => {
    const t = setup('wl-locks-crash-released-');
    const holder = await t.newRun();
    await t.create(holder, t.lockCreated('lock_h'));
    const waiter = await t.newRun();
    expect((await t.create(waiter, t.lockCreated('lock_w'))).lock?.waiter).toBe(
      'queued'
    );
    await t.create(waiter, t.lockReleased('lock_w'));
    t.forgetRecorded(waiter, 'lock_w', 'lock_released', 'releasedEventId');
    await t.create(holder, t.lockReleased('lock_h'));

    const retried = await t.create(waiter, t.lockCreated('lock_w'));
    expect(retried.lock?.status).toBe('released');
    expect(await t.lockEvents(waiter, 'lock_w')).toEqual([
      'lock_created',
      'lock_released',
    ]);
  });

  test('an in-band re-POST that appends nothing does not advance the in-band count', async () => {
    const t = setup('wl-locks-inband-');
    const holder = await t.newRun();
    await t.create(holder, t.lockCreated('lock_h'));
    const runId = await t.newRun();
    const seq = async () =>
      (
        (await t.events.list({ runId, pagination: { limit: 1000 } })) as {
          snapshot?: { seqInBand: number };
        }
      ).snapshot?.seqInBand as number;

    const before = await seq();
    const first = await t.create(runId, t.lockCreated('lock_w'), {
      inBand: true,
      expectedSeqInBand: before,
    });
    expect(first.event?.eventType).toBe('lock_created');
    expect(first.allocated).toBe(1);
    expect(await seq()).toBe(before + 1);

    const again = await t.create(runId, t.lockCreated('lock_w'), {
      inBand: true,
      expectedSeqInBand: before + 1,
    });
    expect(again.event?.eventId).toBe(first.event?.eventId);
    expect(again.allocated).toBe(0);
    expect(await seq()).toBe(before + 1);
  });
});
