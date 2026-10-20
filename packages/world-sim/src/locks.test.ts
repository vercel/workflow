/**
 * world-sim's lock state machine against the conformance suite every World
 * shares, and the log-derived lock invariants against logs that break them.
 */

import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { lockConformance } from '../../world/src/test-support/lock-conformance.js';
import { createIdFactory } from './ids.js';
import { checkLockInvariants } from './invariants.js';
import { createSimStore } from './store.js';
import { createSimWorld } from './world.js';

lockConformance({
  name: 'world-sim',
  // A wall clock, not a fixed one: the conformance lease test waits for a
  // real lease to expire.
  events: () =>
    createSimStore({
      now: () => Date.now(),
      ids: createIdFactory(() => Date.now()),
    }).events,
  capabilities: () => createSimWorld().capabilities,
  newRunId: () => null,
});

// The stage-2 waitlist, on a wall clock (the grace tests sleep past it).
const fifo = { graceMs: 300, waitlistCap: 20 };
const fifoStores = new WeakMap<object, ReturnType<typeof createSimStore>>();
lockConformance({
  name: 'world-sim (fifo)',
  events: () => {
    const store = createSimStore({
      now: () => Date.now(),
      ids: createIdFactory(() => Date.now()),
      locks: { fifo: true, ...fifo },
    });
    fifoStores.set(store.events, store);
    return store.events;
  },
  locks: (events) => {
    const store = fifoStores.get(events);
    if (!store) throw new Error('unknown events storage');
    return {
      get: async (key) => store.allLocks().find((l) => l.key === key) ?? null,
      listHolders: async ({ key, runId }) =>
        store
          .allLockHolders()
          .filter(
            (h) =>
              (key === undefined || h.key === key) &&
              (runId === undefined || h.runId === runId)
          ),
      listWaiters: async ({ key, limit }) =>
        store
          .allLockWaiters()
          .filter((w) => w.key === key)
          .slice(0, limit),
    };
  },
  capabilities: () => createSimWorld({ locks: { fifo: true } }).capabilities,
  newRunId: () => null,
  fifo,
});

describe('checkLockInvariants', () => {
  let seq = 0;
  const at = (ms: number) => new Date(1_704_067_200_000 + ms);
  const lockEvent = (
    runId: string,
    eventType: Event['eventType'],
    correlationId: string,
    eventData: Record<string, unknown>,
    ms: number
  ) =>
    ({
      eventType,
      correlationId,
      runId,
      eventId: `evnt_${++seq}`,
      createdAt: at(ms),
      eventData,
    }) as Event;
  const acquired = (
    runId: string,
    cid: string,
    token: number,
    ms: number,
    extra: Record<string, unknown> = {}
  ) =>
    lockEvent(
      runId,
      'lock_acquired',
      cid,
      {
        key: 'k',
        concurrency: 1,
        effectiveConcurrency: 1,
        fencingToken: token,
        ...extra,
      },
      ms
    );
  const released = (runId: string, cid: string, ms: number) =>
    lockEvent(runId, 'lock_released', cid, { key: 'k' }, ms);
  const terminal = (runId: string, ms: number) =>
    ({
      eventType: 'run_completed',
      runId,
      eventId: `evnt_${++seq}`,
      createdAt: at(ms),
      eventData: {},
    }) as Event;
  const rules = (events: Event[]) =>
    checkLockInvariants({ events, locks: [], holders: [] }).map((v) => v.rule);

  it('accepts holders that leave by release, by run end, and by lease expiry', () => {
    expect(
      rules([
        acquired('r1', 'a', 1, 0),
        released('r1', 'a', 1),
        acquired('r2', 'b', 2, 2),
        terminal('r2', 3),
        acquired('r3', 'c', 3, 4, { leaseExpiresAt: at(5) }),
        acquired('r4', 'd', 4, 6),
      ])
    ).toEqual([]);
  });

  it('flags a second holder admitted past the concurrency', () => {
    expect(
      rules([acquired('r1', 'a', 1, 0), acquired('r2', 'b', 2, 1)])
    ).toEqual(['lock.over-admitted']);
  });

  it('flags a fencing token that does not increase', () => {
    expect(
      rules([
        acquired('r1', 'a', 2, 0),
        released('r1', 'a', 1),
        acquired('r2', 'b', 2, 2),
      ])
    ).toEqual(['lock.fencing-monotonic']);
  });

  it('flags a second lock_created for one scope and a grant after the run ended', () => {
    const created = (ms: number) =>
      lockEvent('r1', 'lock_created', 'a', { key: 'k', concurrency: 1 }, ms);
    expect(
      rules([
        created(0),
        created(1),
        terminal('r1', 2),
        acquired('r1', 'a', 1, 3),
      ])
    ).toEqual(['lock.one-event-per-type', 'lock.grant-after-terminal']);
  });

  it('flags a stored count that disagrees with the log', () => {
    const violations = checkLockInvariants({
      events: [acquired('r1', 'a', 1, 0)],
      locks: [
        {
          key: 'k',
          concurrency: 1,
          count: 0,
          grantSeq: 1,
          createdAt: at(0),
          updatedAt: at(0),
        },
      ],
      holders: [],
    });
    expect(violations.map((v) => v.rule)).toEqual([
      'lock.count-matches-holders',
    ]);
  });
  describe('stage 2 (fifo)', () => {
    const created = (runId: string, cid: string, ms: number) =>
      lockEvent(runId, 'lock_created', cid, { key: 'k', concurrency: 1 }, ms);
    const fifoRules = (events: Event[], movedBack: string[] = []) =>
      checkLockInvariants({
        events,
        locks: [],
        holders: [],
        fifo: { movedBack: new Set(movedBack) },
      }).map((v) => v.rule);

    it('accepts queued scopes granted in the order they queued', () => {
      expect(
        fifoRules([
          acquired('r1', 'h', 1, 0),
          created('r2', 'a', 1),
          created('r3', 'b', 2),
          released('r1', 'h', 3),
          acquired('r2', 'a', 2, 4),
          released('r2', 'a', 5),
          acquired('r3', 'b', 3, 6),
        ])
      ).toEqual([]);
    });

    it('flags a queued scope granted ahead of an earlier one', () => {
      expect(
        fifoRules([
          acquired('r1', 'h', 1, 0),
          created('r2', 'a', 1),
          created('r3', 'b', 2),
          released('r1', 'h', 3),
          acquired('r3', 'b', 2, 4),
        ])
      ).toEqual(['lock.fifo']);
    });

    it('allows grace to move a slow grantee back, and an ended waiter to leave', () => {
      expect(
        fifoRules(
          [
            acquired('r1', 'h', 1, 0),
            created('r2', 'a', 1),
            created('r3', 'b', 2),
            created('r4', 'c', 3),
            terminal('r3', 4),
            released('r1', 'h', 5),
            acquired('r4', 'c', 2, 6),
          ],
          ['r2:a']
        )
      ).toEqual([]);
    });

    it('flags a grant straight past the queue', () => {
      expect(
        fifoRules([
          acquired('r1', 'h', 1, 0),
          created('r2', 'a', 1),
          released('r1', 'h', 2),
          acquired('r3', 'n', 2, 3),
        ])
      ).toEqual(['lock.admitted-past-queue']);
    });

    it('counts reservations in the stored count, and flags a waiter left behind a free slot', () => {
      const lock = {
        key: 'k',
        concurrency: 1,
        count: 1,
        grantSeq: 1,
        createdAt: at(0),
        updatedAt: at(0),
      };
      const waiter = {
        key: 'k',
        seq: 1,
        runId: 'r2',
        correlationId: 'a',
        enqueuedAt: at(1),
      };
      expect(
        checkLockInvariants({
          events: [acquired('r1', 'h', 1, 0), released('r1', 'h', 2)],
          locks: [lock],
          holders: [],
          waiters: [{ ...waiter, grantedAt: at(2) }],
        }).map((v) => v.rule)
      ).toEqual([]);
      expect(
        checkLockInvariants({
          events: [acquired('r1', 'h', 1, 0), released('r1', 'h', 2)],
          locks: [{ ...lock, count: 0 }],
          holders: [],
          waiters: [waiter],
        }).map((v) => v.rule)
      ).toEqual(['lock.no-waiter-behind-free-slot']);
    });
  });
});
