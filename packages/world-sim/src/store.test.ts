import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { beforeEach, describe, expect, it } from 'vitest';
import { createIdFactory } from './ids.js';
import {
  createSimStore,
  type MintedEvent,
  type SimStore,
  type SimStoreOptions,
  type StaleRead,
} from './store.js';

const SPEC = SPEC_VERSION_CURRENT;

function setup(options?: Omit<SimStoreOptions, 'now' | 'ids'>) {
  let now = 1_704_067_200_000;
  const store = createSimStore({
    now: () => now,
    ids: createIdFactory(() => now),
    ...options,
  });
  return { store, tick: (ms: number) => (now += ms), nowMs: () => now };
}

async function createRun(store: SimStore, runId: string) {
  await store.events.create(runId, {
    eventType: 'run_created',
    specVersion: SPEC,
    eventData: {
      deploymentId: 'dpl_sim',
      workflowName: 'workflow//./w//demo',
      input: new Uint8Array([1]),
    },
  });
  await store.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC,
  });
}

type CreateParams = Parameters<SimStore['events']['create']>[2];

/**
 * Commit at a position minted earlier — the hold the world facade opens
 * between the handler boundary and the storage write. `minted` rides on the
 * store's internal create params, which are deliberately not public, so a test
 * driving the store directly has to say so out loud.
 */
function heldAt(minted: MintedEvent): CreateParams {
  return { minted } as unknown as CreateParams;
}

const RUN = 'wrun_01HK153X00000000000105JM0S';

describe('sim store', () => {
  let store: SimStore;
  let tick: (ms: number) => void;

  beforeEach(() => {
    ({ store, tick } = setup());
  });

  it('materializes the run entity from run lifecycle events', async () => {
    await createRun(store, RUN);
    const running = await store.runs.get(RUN);
    expect(running.status).toBe('running');
    expect(running.startedAt).toBeInstanceOf(Date);

    await store.events.create(RUN, {
      eventType: 'run_completed',
      specVersion: SPEC,
      eventData: { output: new Uint8Array([9]) },
    });
    const done = await store.runs.get(RUN);
    expect(done.status).toBe('completed');
    expect(done.output).toEqual(new Uint8Array([9]));
  });

  it('makes run_started idempotent without duplicating the event', async () => {
    await createRun(store, RUN);
    const before = store.allEvents(RUN).length;
    const result = await store.events.create(RUN, {
      eventType: 'run_started',
      specVersion: SPEC,
    });
    expect(result.event).toBeUndefined();
    expect(store.allEvents(RUN).length).toBe(before);
  });

  it('bootstraps a run from run_started when run_created never landed', async () => {
    // The resilient-start path: `start()` fires run_created and the queue
    // message concurrently, and the queue message is allowed to win.
    await store.events.create(RUN, {
      eventType: 'run_started',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_sim',
        workflowName: 'workflow//./w//demo',
        input: new Uint8Array([1]),
      },
    });
    const events = store.allEvents(RUN);
    expect(events.map((e) => e.eventType)).toEqual([
      'run_created',
      'run_started',
    ]);
    // The synthetic run_created must sort first, or replay sees the run start
    // before it exists.
    expect(events[0].eventId < events[1].eventId).toBe(true);
    expect((await store.runs.get(RUN)).status).toBe('running');
  });

  describe('step lifecycle', () => {
    beforeEach(() => createRun(store, RUN));

    it('tracks attempts across retries', async () => {
      await store.events.create(RUN, {
        eventType: 'step_created',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: { stepName: 'step//./w//charge', input: new Uint8Array() },
      });
      await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_1',
      });
      await store.events.create(RUN, {
        eventType: 'step_retrying',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: { error: new Uint8Array() },
      });
      await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_1',
      });
      const step = await store.steps.get(RUN, 'step_1');
      expect(step.attempt).toBe(2);
      expect(step.status).toBe('running');
    });

    it('rejects a second terminal write for the same step', async () => {
      await store.events.create(RUN, {
        eventType: 'step_created',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: { stepName: 'step//./w//charge', input: new Uint8Array() },
      });
      await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_1',
      });
      await store.events.create(RUN, {
        eventType: 'step_completed',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: { result: new Uint8Array() },
      });
      await expect(
        store.events.create(RUN, {
          eventType: 'step_completed',
          specVersion: SPEC,
          correlationId: 'step_1',
          eventData: { result: new Uint8Array() },
        })
      ).rejects.toBeInstanceOf(EntityConflictError);
    });

    it('creates the step on a lazy step_started and keeps the log sorted', async () => {
      const result = await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: {
          stepName: 'step//./w//charge',
          input: new Uint8Array([7]),
        },
      });
      expect(result.stepCreated).toBe(true);

      const events = store.allEvents(RUN).slice(-2);
      expect(events.map((e) => e.eventType)).toEqual([
        'step_created',
        'step_started',
      ]);
      expect(events[0].eventId < events[1].eventId).toBe(true);
      // The input belongs to the synthetic step_created, not the started row.
      expect(
        (events[0] as { eventData: { input: unknown } }).eventData.input
      ).toEqual(new Uint8Array([7]));
      expect(
        (events[1] as { eventData?: { input?: unknown } }).eventData?.input
      ).toBeUndefined();
    });

    it('treats a lazy step_started for an existing step as a lost create race', async () => {
      const lazy = {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: { stepName: 'step//./w//charge', input: new Uint8Array() },
      } as const;
      await store.events.create(RUN, lazy);
      // Exactly-once ownership: the loser must be told to skip, not allowed to
      // re-run the body.
      await expect(store.events.create(RUN, lazy)).rejects.toBeInstanceOf(
        EntityConflictError
      );
    });

    it('honours retryAfter', async () => {
      await store.events.create(RUN, {
        eventType: 'step_created',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: { stepName: 'step//./w//charge', input: new Uint8Array() },
      });
      await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_1',
      });
      await store.events.create(RUN, {
        eventType: 'step_retrying',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: {
          error: new Uint8Array(),
          retryAfter: new Date(1_704_067_200_000 + 10_000),
        },
      });
      await expect(
        store.events.create(RUN, {
          eventType: 'step_started',
          specVersion: SPEC,
          correlationId: 'step_1',
        })
      ).rejects.toThrow(/retryAfter/);

      tick(10_000);
      await expect(
        store.events.create(RUN, {
          eventType: 'step_started',
          specVersion: SPEC,
          correlationId: 'step_1',
        })
      ).resolves.toBeTruthy();
    });
  });

  describe('hooks', () => {
    beforeEach(() => createRun(store, RUN));

    const hookCreated = (hookId: string, token: string) =>
      ({
        eventType: 'hook_created',
        specVersion: SPEC,
        correlationId: hookId,
        eventData: { token },
      }) as const;

    it('grants a token to one live hook at a time and journals conflicts', async () => {
      await store.events.create(RUN, hookCreated('hook_1', 'approval:1'));
      const conflict = await store.events.create(
        RUN,
        hookCreated('hook_2', 'approval:1')
      );
      // A conflict is data the workflow must observe, not an exception the
      // caller has to handle.
      expect(conflict.event?.eventType).toBe('hook_conflict');
      expect(conflict.hook).toBeUndefined();
      expect(store.hookByToken('approval:1')?.hookId).toBe('hook_1');
    });

    it('releases the token on dispose and refuses later resumes', async () => {
      await store.events.create(RUN, hookCreated('hook_1', 'approval:1'));
      await store.events.create(RUN, {
        eventType: 'hook_disposed',
        specVersion: SPEC,
        correlationId: 'hook_1',
      });
      expect(store.hookByToken('approval:1')).toBeUndefined();
      await expect(
        store.events.create(RUN, {
          eventType: 'hook_received',
          specVersion: SPEC,
          correlationId: 'hook_1',
          eventData: { payload: new Uint8Array() },
        })
      ).rejects.toBeInstanceOf(HookNotFoundError);

      // The token is free again for a new hook.
      await expect(
        store.events.create(RUN, hookCreated('hook_2', 'approval:1'))
      ).resolves.toMatchObject({ hook: { hookId: 'hook_2' } });
    });

    it('carries a resume context so a resume needs no run read', async () => {
      const result = await store.events.create(
        RUN,
        hookCreated('hook_1', 'approval:1')
      );
      expect(result.hook?.resumeContext).toMatchObject({
        deploymentId: 'dpl_sim',
        workflowName: 'workflow//./w//demo',
      });
    });
  });

  describe('terminal runs', () => {
    beforeEach(() => createRun(store, RUN));

    it('rejects new entities but accepts the terminal write of a running step', async () => {
      await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: { stepName: 'step//./w//charge', input: new Uint8Array() },
      });
      await store.events.create(RUN, {
        eventType: 'run_cancelled',
        specVersion: SPEC,
      });

      await expect(
        store.events.create(RUN, {
          eventType: 'hook_created',
          specVersion: SPEC,
          correlationId: 'hook_1',
          eventData: { token: 'approval:1' },
        })
      ).rejects.toBeInstanceOf(EntityConflictError);

      // The in-flight step still gets to report back — that write is how an
      // inline step body closes itself out.
      await expect(
        store.events.create(RUN, {
          eventType: 'step_completed',
          specVersion: SPEC,
          correlationId: 'step_1',
          eventData: { result: new Uint8Array() },
        })
      ).resolves.toBeTruthy();
    });

    it('maps run_started on a terminal run to RunExpiredError', async () => {
      await store.events.create(RUN, {
        eventType: 'run_completed',
        specVersion: SPEC,
        eventData: {},
      });
      await expect(
        store.events.create(RUN, {
          eventType: 'run_started',
          specVersion: SPEC,
        })
      ).rejects.toBeInstanceOf(RunExpiredError);
    });

    it('is idempotent for a repeated cancel', async () => {
      await store.events.create(RUN, {
        eventType: 'run_cancelled',
        specVersion: SPEC,
      });
      await expect(
        store.events.create(RUN, {
          eventType: 'run_cancelled',
          specVersion: SPEC,
        })
      ).resolves.toMatchObject({ run: { status: 'cancelled' } });
    });
  });

  describe('pagination', () => {
    it('pages events ascending with a resumable cursor', async () => {
      await createRun(store, RUN);
      for (let i = 0; i < 5; i++) {
        tick(1);
        await store.events.create(RUN, {
          eventType: 'step_created',
          specVersion: SPEC,
          correlationId: `step_${i}`,
          eventData: { stepName: 'step//./w//s', input: new Uint8Array() },
        });
      }
      const first = await store.events.list({
        runId: RUN,
        pagination: { limit: 3, sortOrder: 'asc' },
      });
      expect(first.data).toHaveLength(3);
      expect(first.hasMore).toBe(true);

      const second = await store.events.list({
        runId: RUN,
        pagination: {
          limit: 10,
          sortOrder: 'asc',
          cursor: first.cursor ?? undefined,
        },
      });
      expect(second.hasMore).toBe(false);
      expect([...first.data, ...second.data].map((e) => e.eventId)).toEqual(
        store.allEvents(RUN).map((e) => e.eventId)
      );
    });
  });

  describe('precondition guard', () => {
    it('fences a replay write behind an out-of-band one, only when enabled', async () => {
      const guarded = setup({ preconditionGuard: true });
      await createRun(guarded.store, RUN);
      await guarded.store.events.create(RUN, {
        eventType: 'hook_created',
        specVersion: SPEC,
        correlationId: 'hook_1',
        eventData: { token: 'approval:1' },
      });

      guarded.tick(10);
      const snapshot = guarded.nowMs();
      guarded.tick(10);
      // An out-of-band resume: no stateUpdatedAt, so it advances the marker.
      await guarded.store.events.create(RUN, {
        eventType: 'hook_received',
        specVersion: SPEC,
        correlationId: 'hook_1',
        eventData: { payload: new Uint8Array() },
      });

      await expect(
        guarded.store.events.create(
          RUN,
          {
            eventType: 'step_created',
            specVersion: SPEC,
            correlationId: 'step_1',
            eventData: { stepName: 'step//./w//s', input: new Uint8Array() },
          },
          { stateUpdatedAt: snapshot }
        )
      ).rejects.toThrow(/out of band/);

      // An up-to-date snapshot passes — an equal timestamp must not livelock.
      await expect(
        guarded.store.events.create(
          RUN,
          {
            eventType: 'step_created',
            specVersion: SPEC,
            correlationId: 'step_1',
            eventData: { stepName: 'step//./w//s', input: new Uint8Array() },
          },
          { stateUpdatedAt: guarded.nowMs() }
        )
      ).resolves.toBeTruthy();
    });
  });

  describe('append-only log', () => {
    const hook = {
      eventType: 'hook_created',
      specVersion: SPEC,
      correlationId: 'hook_1',
      eventData: { token: 'approval:1' },
    } as const;
    const step = {
      eventType: 'step_created',
      specVersion: SPEC,
      correlationId: 'step_1',
      eventData: { stepName: 'step//./w//s', input: new Uint8Array() },
    } as const;

    it('is off by default: a held write lands behind one committed sooner', async () => {
      await createRun(store, RUN);
      // The handler boundary takes a position; the write is then held.
      const minted = store.mintEvent();
      tick(10);
      const overtook = await store.events.create(RUN, hook);
      const held = await store.events.create(RUN, step, heldAt(minted));

      expect(held.event?.eventId).toBe(minted.eventId);
      // The log gained a row in the past: the later commit sorts first, so a
      // reader that already saw `overtook` has been passed by something older.
      const ids = store.allEvents(RUN).map((e) => e.eventId);
      expect(ids.indexOf(minted.eventId)).toBeLessThan(
        ids.indexOf(overtook.event?.eventId ?? '')
      );
    });

    it('re-mints a write that was overtaken while it was held', async () => {
      const world = setup({ appendOnlyLog: true });
      await createRun(world.store, RUN);
      const minted = world.store.mintEvent();
      world.tick(10);
      const overtook = await world.store.events.create(RUN, hook);
      const held = await world.store.events.create(RUN, step, heldAt(minted));

      // The reserved position is abandoned. Nothing is ever inserted behind a
      // row a reader could already have seen, so log order is commit order.
      const heldId = held.event?.eventId ?? '';
      expect(heldId).not.toBe(minted.eventId);
      expect(heldId > (overtook.event?.eventId ?? '')).toBe(true);
      const ids = world.store.allEvents(RUN).map((e) => e.eventId);
      expect(ids).toEqual([...ids].sort());
      expect(ids.at(-1)).toBe(heldId);
    });

    it('leaves an uncontended write at the position it minted', async () => {
      const world = setup({ appendOnlyLog: true });
      await createRun(world.store, RUN);
      const minted = world.store.mintEvent();
      world.tick(10);
      const uncontended = await world.store.events.create(
        RUN,
        step,
        heldAt(minted)
      );

      // Still the newest position when it arrived, so it keeps both halves of
      // the mint — including a `createdAt` from before the tick. A scenario
      // that never holds a write mid-flight logs the same bytes either way.
      expect(uncontended.event?.eventId).toBe(minted.eventId);
      expect(uncontended.event?.createdAt).toEqual(minted.createdAt);
    });

    it('punches a hole in a withheld read by default', async () => {
      const seen: StaleRead[] = [];
      const world = setup({ onStaleRead: (read) => seen.push(read) });
      await createRun(world.store, RUN);
      world.store.withholdNextEvent(1);
      const withheld = await world.store.events.create(RUN, hook);
      world.tick(1);
      const after = await world.store.events.create(RUN, step);

      const page = await world.store.events.list({
        runId: RUN,
        pagination: { limit: 50, sortOrder: 'asc' },
      });
      const ids = page.data.map((e) => e.eventId);
      // The withheld event vanishes and its successor stays: the reader holds
      // proof that something newer exists, which is what no watermark can see.
      expect(ids).not.toContain(withheld.event?.eventId);
      expect(ids).toContain(after.event?.eventId);
      expect(seen).toEqual([
        { eventId: withheld.event?.eventId, hidden: 1, truncated: false },
      ]);
    });

    it('truncates a withheld read rather than punching a hole', async () => {
      const seen: StaleRead[] = [];
      const world = setup({
        appendOnlyLog: true,
        onStaleRead: (read) => seen.push(read),
      });
      await createRun(world.store, RUN);
      world.store.withholdNextEvent(1);
      const withheld = await world.store.events.create(RUN, hook);
      world.tick(1);
      const after = await world.store.events.create(RUN, step);

      const page = await world.store.events.list({
        runId: RUN,
        pagination: { limit: 50, sortOrder: 'asc' },
      });
      const ids = page.data.map((e) => e.eventId);
      // Cut short at the withheld event: a prefix of the real log. Still short
      // — both events are missing, `after` included — but not self-contradictory.
      expect(ids).not.toContain(withheld.event?.eventId);
      expect(ids).not.toContain(after.event?.eventId);
      expect(ids).toEqual(
        world.store
          .allEvents(RUN)
          .map((e) => e.eventId)
          .filter((id) => id < (withheld.event?.eventId ?? ''))
      );
      expect(seen).toEqual([
        { eventId: withheld.event?.eventId, hidden: 2, truncated: true },
      ]);
    });

    it('serves the real log once the withhold window closes', async () => {
      const world = setup({ appendOnlyLog: true });
      await createRun(world.store, RUN);
      world.store.withholdNextEvent(1);
      await world.store.events.create(RUN, hook);

      const read = () =>
        world.store.events
          .list({ runId: RUN, pagination: { limit: 50, sortOrder: 'asc' } })
          .then((p) => p.data.length);
      const short = await read();
      expect(await read()).toBe(short + 1);
    });
  });

  describe('seeding a log', () => {
    // `seedFromLog` folds a committed log back into entity rows, and it is the
    // path a replay check cold-starts from. If that fold disagrees with the one
    // the write path runs, the replay diverges from the run it is checking for
    // reasons that have nothing to do with the runtime under test — so the
    // property worth pinning is that the two agree.
    //
    // Timestamps line up for free: an event's `createdAt` is minted inside the
    // same `create` call that commits it, so the seeded row and the written row
    // read the same clock even when the test ticks between writes.
    const seededFrom = (source: SimStore): SimStore => {
      const { store: fresh } = setup();
      fresh.seedFromLog(source.allEvents());
      return fresh;
    };

    const expectSameEntities = (source: SimStore, fresh: SimStore) => {
      expect(fresh.allRuns()).toEqual(source.allRuns());
      expect(fresh.allSteps()).toEqual(source.allSteps());
      expect(fresh.allHooks()).toEqual(source.allHooks());
      expect(fresh.allWaits()).toEqual(source.allWaits());
    };

    it('rebuilds the run and its steps', async () => {
      await createRun(store, RUN);
      await store.events.create(RUN, {
        eventType: 'attr_set',
        specVersion: SPEC,
        eventData: {
          changes: [
            { key: 'kept', value: 'yes' },
            { key: 'dropped', value: null },
          ],
        },
      });
      await store.events.create(RUN, {
        eventType: 'step_created',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: {
          stepName: 'step//./w//charge',
          input: new Uint8Array([1]),
        },
      });
      await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_1',
      });
      await store.events.create(RUN, {
        eventType: 'step_completed',
        specVersion: SPEC,
        correlationId: 'step_1',
        eventData: { result: new Uint8Array([2]) },
      });
      // A lazy start, so the seeded fold has to pick up the synthetic
      // `step_created` the write path wrote alongside it.
      await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_2',
        eventData: { stepName: 'step//./w//ship', input: new Uint8Array([3]) },
      });
      await store.events.create(RUN, {
        eventType: 'step_retrying',
        specVersion: SPEC,
        correlationId: 'step_2',
        eventData: { error: new Uint8Array([4]) },
      });
      tick(1);
      await store.events.create(RUN, {
        eventType: 'step_started',
        specVersion: SPEC,
        correlationId: 'step_2',
      });

      const fresh = seededFrom(store);
      expectSameEntities(store, fresh);
      // The rows are not trivially empty on either side.
      expect(fresh.allSteps(RUN).map((s) => s.status)).toEqual([
        'completed',
        'running',
      ]);
      expect(fresh.allSteps(RUN)[1].attempt).toBe(2);
      expect(fresh.allRuns()[0].attributes).toEqual({ kept: 'yes' });
    });

    it('rebuilds hooks and waits, including who owns a token', async () => {
      await createRun(store, RUN);
      await store.events.create(RUN, {
        eventType: 'hook_created',
        specVersion: SPEC,
        correlationId: 'hook_1',
        eventData: { token: 'approval:1' },
      });
      await store.events.create(RUN, {
        eventType: 'hook_received',
        specVersion: SPEC,
        correlationId: 'hook_1',
        eventData: { payload: new Uint8Array([5]) },
      });
      await store.events.create(RUN, {
        eventType: 'hook_created',
        specVersion: SPEC,
        correlationId: 'hook_2',
        eventData: { token: 'approval:2' },
      });
      await store.events.create(RUN, {
        eventType: 'hook_disposed',
        specVersion: SPEC,
        correlationId: 'hook_2',
      });
      await store.events.create(RUN, {
        eventType: 'wait_created',
        specVersion: SPEC,
        correlationId: 'wait_1',
        eventData: { resumeAt: new Date(1_704_067_260_000) },
      });
      await store.events.create(RUN, {
        eventType: 'wait_completed',
        specVersion: SPEC,
        correlationId: 'wait_1',
      });

      const fresh = seededFrom(store);
      expectSameEntities(store, fresh);
      // A disposed hook releases its token on both paths; a live one keeps it.
      expect(fresh.hookByToken('approval:1')).toEqual(
        store.hookByToken('approval:1')
      );
      expect(fresh.hookByToken('approval:2')).toBeUndefined();
      expect(fresh.allWaits(RUN)[0].status).toBe('completed');
    });

    it('releases the hooks and waits of a terminated run', async () => {
      await createRun(store, RUN);
      await store.events.create(RUN, {
        eventType: 'hook_created',
        specVersion: SPEC,
        correlationId: 'hook_1',
        eventData: { token: 'approval:1' },
      });
      await store.events.create(RUN, {
        eventType: 'wait_created',
        specVersion: SPEC,
        correlationId: 'wait_1',
        eventData: { resumeAt: new Date(1_704_067_260_000) },
      });
      await store.events.create(RUN, {
        eventType: 'run_completed',
        specVersion: SPEC,
        eventData: { output: new Uint8Array([6]) },
      });

      const fresh = seededFrom(store);
      expectSameEntities(store, fresh);
      expect(fresh.allHooks()).toEqual([]);
      expect(fresh.allWaits()).toEqual([]);
      expect(fresh.allRuns()[0].status).toBe('completed');
    });
  });
});
