import {
  EntityConflictError,
  RUN_ERROR_CODES,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  SPEC_VERSION_RATE_LIMITS,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type WorkflowRun,
} from '@workflow/world';
import { assert, describe, expect, it } from 'vitest';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { loadWorkflowRunEventsFrom } from '../../test-support/load-events.js';
import {
  MAX_BATCH_EVENTS,
  MAX_IN_BAND_CREATION_BATCH_BYTES,
} from '../constants.js';
import {
  InBandWriter,
  OrchestratorSupersededError,
  RESILIENT_START_SNAPSHOT,
  requireLoadSnapshot,
} from './in-band-writer.js';

const RUN = 'wrun_fence';

function seeded(options: ConstructorParameters<typeof AppendOnlyWorld>[0]) {
  const world = new AppendOnlyWorld(options);
  world.seedRun({
    runId: RUN,
    workflowName: 'wf',
    deploymentId: 'dpl',
    status: 'running',
    input: new Uint8Array(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  return world;
}

/** The committed event at `index` of the World's log. */
function eventAt(world: AppendOnlyWorld, index: number) {
  const event = world.events[index];
  if (!event) throw new Error(`no event at index ${index}`);
  return event;
}

const waitCreated = (cid: string) =>
  ({
    eventType: 'wait_created',
    specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    correlationId: cid,
    eventData: { resumeAt: new Date() },
  }) as const;

describe('InBandWriter', () => {
  it('starts from the load snapshot and advances by allocated positions', async () => {
    const world = seeded({});
    const writer = new InBandWriter(world.asWorld(), RUN);
    const log = await loadWorkflowRunEventsFrom(world.asWorld(), RUN);
    writer.adoptSnapshot(requireLoadSnapshot(RUN, log));
    expect(writer.expectedSeqInBand).toBe(1);

    await writer.create(waitCreated('wait_a'));
    expect(writer.expectedSeqInBand).toBe(2);
    await writer.createBatch([
      { event: waitCreated('wait_b') },
      { event: waitCreated('wait_c') },
    ]);
    expect(writer.expectedSeqInBand).toBe(4);
    expect(world.creates.map((c) => c.params?.expectedSeqInBand)).toEqual([
      1, 2, 2,
    ]);
    expect(world.creates.every((c) => c.params?.inBand === true)).toBe(true);
  });

  it('fills in a payload the World left out of the committed event', async () => {
    const world = seeded({});
    const base = world.asWorld();
    // A World that stores the payload but does not echo it on the create.
    const stripping = {
      ...base,
      events: {
        ...base.events,
        create: async (...args: Parameters<typeof base.events.create>) => {
          const result = await base.events.create(...args);
          if (!result.event) return result;
          const { result: _omitted, ...eventData } = (
            result.event as { eventData: Record<string, unknown> }
          ).eventData;
          return { ...result, event: { ...result.event, eventData } as never };
        },
      },
    } as typeof base;
    const writer = new InBandWriter(stripping, RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(RUN, await loadWorkflowRunEventsFrom(base, RUN))
    );

    const payload = new Uint8Array([1, 2, 3]);
    const written = await writer.create({
      eventType: 'step_completed',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      correlationId: 'step_a',
      eventData: { stepName: 'add', result: payload },
    } as never);

    expect(
      (written as unknown as { event: { eventData: { result?: unknown } } })
        .event.eventData.result
    ).toEqual(payload);
  });

  it('out-of-band writes move seq but not the in-band count', async () => {
    const world = seeded({});
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: 'hook_a',
    } as never);
    await writer.create(waitCreated('wait_a'));
    expect(world.seq).toBe(3);
    expect(world.seqInBand).toBe(2);
  });

  it('stops for good once superseded and never adopts the error value', async () => {
    const world = seeded({});
    const stale = new InBandWriter(world.asWorld(), RUN);
    const winner = new InBandWriter(world.asWorld(), RUN);
    const snapshot = requireLoadSnapshot(
      RUN,
      await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
    );
    stale.adoptSnapshot(snapshot);
    winner.adoptSnapshot(snapshot);

    await winner.create(waitCreated('wait_a'));
    await expect(stale.create(waitCreated('wait_b'))).rejects.toSatisfy(
      OrchestratorSupersededError.is
    );
    expect(stale.isSuperseded).toBe(true);
    expect(stale.expectedSeqInBand).toBe(1);
    const before = world.events.length;
    await expect(stale.create(waitCreated('wait_c'))).rejects.toSatisfy(
      OrchestratorSupersededError.is
    );
    expect(() => stale.assertActive()).toThrow(OrchestratorSupersededError);
    expect(world.events.length).toBe(before);
  });

  it('serializes concurrent writes so a fan-out is not refused', async () => {
    const world = seeded({});
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    await Promise.all(
      ['a', 'b', 'c'].map((id) => writer.create(waitCreated(`wait_${id}`)))
    );
    expect(writer.isStopped).toBe(false);
    expect(world.seqInBand).toBe(4);
  });

  it('keeps going after a definite refusal and stops on an unknown outcome', async () => {
    const world = seeded({});
    const base = world.asWorld();
    let failWith: unknown;
    const flaky = {
      capabilities: base.capabilities,
      events: {
        ...base.events,
        create: async (...args: Parameters<typeof base.events.create>) => {
          if (failWith) {
            const error = failWith;
            failWith = undefined;
            throw error;
          }
          return base.events.create(...args);
        },
      },
    } as typeof base;
    const writer = new InBandWriter(flaky, RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(RUN, await loadWorkflowRunEventsFrom(base, RUN))
    );
    failWith = new WorkflowWorldError('nope', { status: 409 });
    await expect(writer.create(waitCreated('wait_a'))).rejects.toThrow('nope');
    expect(writer.isStopped).toBe(false);
    failWith = new Error('socket hang up');
    await expect(writer.create(waitCreated('wait_b'))).rejects.toThrow(
      'socket hang up'
    );
    expect(writer.isStopped).toBe(true);
    expect(writer.isSuperseded).toBe(false);
  });

  it('refuses a World that does not declare the fence', () => {
    const base = seeded({}).asWorld();
    expect(() => new InBandWriter({ ...base, capabilities: {} }, RUN)).toThrow(
      /capabilities\.inBandFence/
    );
  });

  it('refuses to write before a snapshot was adopted, without reaching the World', async () => {
    const world = seeded({});
    const writer = new InBandWriter(world.asWorld(), RUN);
    await expect(writer.create(waitCreated('wait_a'))).rejects.toThrow(
      /wrote before adopting a log snapshot/
    );
    expect(world.creates).toEqual([]);
  });

  it('requires a snapshot with a non-empty log', () => {
    const log = { events: [{}], cursor: null };
    expect(() => requireLoadSnapshot(RUN, log)).toThrow(WorkflowWorldError);
    try {
      requireLoadSnapshot(RUN, log);
    } catch (error) {
      expect((error as WorkflowWorldError).code).toBe(
        RUN_ERROR_CODES.WORLD_CONTRACT_ERROR
      );
    }
    // A resilient start: no run yet, so nothing listed and no snapshot.
    expect(requireLoadSnapshot(RUN, { events: [] })).toEqual(
      RESILIENT_START_SNAPSHOT
    );
    const snapshot = { seq: 3, seqInBand: 2 };
    expect(requireLoadSnapshot(RUN, { events: [{}], snapshot })).toBe(snapshot);
  });

  it('does not advance for a write answered with an event it already knew (idempotent replay)', async () => {
    const world = seeded({});
    const base = world.asWorld();
    const existing = world.events[0];
    const replaying = {
      capabilities: base.capabilities,
      events: {
        ...base.events,
        create: async () => ({ event: existing }),
      },
    } as unknown as typeof base;
    const writer = new InBandWriter(replaying, RUN);
    writer.adoptSnapshot({ seq: 1, seqInBand: 1 });
    await writer.create(waitCreated('wait_a'));
    expect(writer.expectedSeqInBand).toBe(1);
  });

  it('names the load position on a write that names none', async () => {
    const world = seeded({});
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    await writer.create(waitCreated('wait_a'));
    expect(world.creates[0]?.params?.eventCount).toBe(1);
    await writer.create(waitCreated('wait_b'), { eventCount: 2 });
    expect(world.creates[1]?.params?.eventCount).toBe(2);
  });

  it('advances by the allocation the World reports', async () => {
    const world = seeded({});
    const base = world.asWorld();
    const reporting = {
      capabilities: base.capabilities,
      events: {
        ...base.events,
        create: async (...args: Parameters<typeof base.events.create>) => ({
          ...(await base.events.create(...args)),
          allocated: 0,
        }),
      },
    } as typeof base;
    const writer = new InBandWriter(reporting, RUN);
    writer.adoptSnapshot({ seq: 1, seqInBand: 1 });
    await writer.create(waitCreated('wait_a'));
    expect(writer.expectedSeqInBand).toBe(1);
  });

  it('keeps sending the writes stopDecisions allows, in order, and refuses the rest', async () => {
    const world = seeded({});
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    const stop = new Error('path may have changed');
    writer.stopDecisions(stop, (events) =>
      events.every((event) => event.correlationId?.startsWith('keep'))
    );
    const results = await Promise.allSettled([
      writer.create(waitCreated('drop_1')),
      writer.create(waitCreated('keep_1')),
      writer.createAhead(waitCreated('drop_2'), {}, () => {}),
      writer.createAhead(waitCreated('keep_2'), {}, () => {}),
    ]);

    expect(results.map((r) => r.status)).toEqual([
      'rejected',
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(world.events.slice(1).map((e) => e.correlationId)).toEqual([
      'keep_1',
      'keep_2',
    ]);
    expect(writer.isStopped).toBe(false);
    // No new step body starts.
    expect(() => writer.assertActive()).toThrow(stop);
  });

  describe('slot prediction', () => {
    /** A writer on a World that commits a write and holds its answer. */
    async function answersHeld() {
      const answers: (() => void)[] = [];
      const world = seeded({
        async afterCommit() {
          await new Promise<void>((resolve) => answers.push(resolve));
        },
      });
      const writer = new InBandWriter(world.asWorld(), RUN);
      writer.adoptSnapshot(
        requireLoadSnapshot(
          RUN,
          await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
        )
      );
      const committed = async (events: number) => {
        for (let i = 0; i < 200 && world.events.length < events; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(world.events).toHaveLength(events);
      };
      return { world, writer, answers, committed };
    }

    it('counts a write the live feed echoed before its answer once', async () => {
      const { world, writer, answers, committed } = await answersHeld();
      const write = writer.createAhead(waitCreated('w1'), {}, () => {});
      // Committed at slot 2; the answer is held.
      await committed(2);
      expect(writer.predictNextSlot()).toBe(3);

      // The feed's echo of the write. Its position is in `knownMaxSlot`
      // now, and must not be counted again as a pending one.
      writer.observeEvent(eventAt(world, 1));
      expect(writer.predictNextSlot()).toBe(3);
      // The same echo again (a poll after the push) changes nothing.
      writer.observeEvent(eventAt(world, 1));
      expect(writer.predictNextSlot()).toBe(3);

      // Another writer's event above it is a position of its own.
      const foreign = world.appendOutOfBand({
        eventType: 'hook_received',
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        correlationId: 'hook_other',
        eventData: { payload: new Uint8Array() },
      } as never);
      writer.observeEvent(foreign);
      expect(writer.predictNextSlot()).toBe(4);

      answers.shift()?.();
      await write;
      expect(writer.predictNextSlot()).toBe(4);
    });

    it('counts the echoed part of a batch once, and the rest as pending', async () => {
      const { world, writer, answers, committed } = await answersHeld();
      // One group: the three events go out as one batch.
      const batch = writer.createBatchAhead(
        [{ event: waitCreated('w1') }, { event: waitCreated('w2') }],
        {},
        () => {}
      );
      const single = writer.createAhead(waitCreated('w3'), {}, () => {});
      await committed(4);
      expect(world.batches).toHaveLength(1);
      expect(writer.predictNextSlot()).toBe(5);

      // The feed echoes two of the three before the answer.
      writer.observeEvent(eventAt(world, 1));
      expect(writer.predictNextSlot()).toBe(5);
      writer.observeEvent(eventAt(world, 2));
      expect(writer.predictNextSlot()).toBe(5);

      answers.shift()?.();
      await Promise.all([batch, single]);
      expect(writer.predictNextSlot()).toBe(5);
      // The third echo, after the answer.
      writer.observeEvent(eventAt(world, 3));
      expect(writer.predictNextSlot()).toBe(5);
    });

    it("counts another writer's event below a write in flight as its own position", async () => {
      const { world, writer, answers, committed } = await answersHeld();
      // Another writer takes slot 2 before this writer's write is sent.
      const foreign = world.appendOutOfBand({
        eventType: 'hook_received',
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        correlationId: 'hook_other',
        eventData: { payload: new Uint8Array() },
      } as never);
      const write = writer.createAhead(waitCreated('w1'), {}, () => {});
      await committed(3);
      // Unaware of the other event, the next write is expected at 3.
      expect(writer.predictNextSlot()).toBe(3);
      // The feed delivers both: the other writer's, then the echo.
      writer.observeEvent(foreign);
      expect(writer.predictNextSlot()).toBe(4);
      writer.observeEvent(eventAt(world, 2));
      expect(writer.predictNextSlot()).toBe(4);
      answers.shift()?.();
      await write;
      expect(writer.predictNextSlot()).toBe(4);
    });

    it('counts an answered write once before it settles', async () => {
      const world = seeded({});
      const writer = new InBandWriter(world.asWorld(), RUN);
      writer.adoptSnapshot(
        requireLoadSnapshot(
          RUN,
          await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
        )
      );
      // `verify` runs once the answer is taken in, before the write leaves
      // the queue: a prediction made there (a step body resuming in the
      // same turn) must not count the answered write twice.
      let predictedInVerify: number | undefined;
      await writer.createRequired(waitCreated('w1'), {}, () => {
        predictedInVerify = writer.predictNextSlot();
      });
      expect(predictedInVerify).toBe(3);
      expect(writer.predictNextSlot()).toBe(3);

      let predictedInBatchVerify: number | undefined;
      await writer.createBatchRequired(
        [{ event: waitCreated('w2') }, { event: waitCreated('w3') }],
        {},
        () => {
          predictedInBatchVerify = writer.predictNextSlot();
        }
      );
      expect(predictedInBatchVerify).toBe(5);
      expect(writer.predictNextSlot()).toBe(5);
    });
  });

  describe('run-ahead writes', () => {
    async function ready() {
      // Every write is held until released, as a write in flight is.
      const gates: (() => void)[] = [];
      const world = seeded({
        async beforeCreate() {
          await new Promise<void>((resolve) => gates.push(resolve));
        },
      });
      const writer = new InBandWriter(world.asWorld(), RUN);
      writer.adoptSnapshot(
        requireLoadSnapshot(
          RUN,
          await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
        )
      );
      const releaseAll = async () => {
        while (gates.length > 0 || (await settled())) {
          gates.shift()?.();
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (gates.length === 0) break;
        }
      };
      const settled = async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return gates.length > 0;
      };
      return { world, writer, releaseAll };
    }

    it('sends run-ahead writes queued before their turn as one batch, in order', async () => {
      const { world, writer, releaseAll } = await ready();
      const verified: string[] = [];
      const first = writer.createAhead(waitCreated('w1'), {}, () =>
        verified.push('w1')
      );
      const second = writer.createAhead(waitCreated('w2'), {}, () =>
        verified.push('w2')
      );
      const third = writer.createBatchAhead(
        [{ event: waitCreated('w3') }, { event: waitCreated('w4') }],
        {},
        () => verified.push('w3+w4')
      );
      expect(writer.predictNextSlot()).toBe(6);
      await releaseAll();
      await Promise.all([first, second, third]);

      // All three were queued before the group's turn came: one batch.
      expect(world.batches).toEqual([
        ['wait_created', 'wait_created', 'wait_created', 'wait_created'],
      ]);
      expect(verified).toEqual(['w1', 'w2', 'w3+w4']);
      expect(world.events.slice(1).map((e) => e.correlationId)).toEqual([
        'w1',
        'w2',
        'w3',
        'w4',
      ]);
      expect(writer.expectedSeqInBand).toBe(5);
    });

    it('asks a batch for resolved data only when a write asked for all of it', async () => {
      const { world, writer, releaseAll } = await ready();
      const replay = { resolveData: 'skip-step-inputs' as const };
      const writes = [
        writer.createAhead(waitCreated('w1'), replay, () => {}),
        writer.createAhead(waitCreated('w2'), replay, () => {}),
        writer.createAhead(waitCreated('w3'), replay, () => {}),
      ];
      await releaseAll();
      await Promise.all(writes);
      const batched = (cids: string[]) =>
        world.creates
          .filter((c) => cids.includes(c.event.correlationId as string))
          .map((c) => c.params?.resolveData);
      expect(world.batches.length).toBeGreaterThan(0);
      expect(batched(['w2', 'w3'])).toEqual([undefined, undefined]);

      const all = [
        writer.createAhead(waitCreated('a1'), {}, () => {}),
        writer.createAhead(waitCreated('a2'), {}, () => {}),
        writer.createAhead(waitCreated('a3'), { resolveData: 'all' }, () => {}),
      ];
      await releaseAll();
      await Promise.all(all);
      expect(batched(['a2', 'a3'])).toEqual(['all', 'all']);
    });

    it('starts a new batch rather than send more than MAX_BATCH_EVENTS events in one', async () => {
      const { world, writer, releaseAll } = await ready();
      const writes = Array.from({ length: MAX_BATCH_EVENTS + 2 }, (_, i) =>
        writer.createAhead(waitCreated(`w${i}`), {}, () => {})
      );
      await releaseAll();
      await Promise.all(writes);

      expect(
        Math.max(...world.batches.map((batch) => batch.length))
      ).toBeLessThanOrEqual(MAX_BATCH_EVENTS);
      expect(world.events.slice(1).map((e) => e.correlationId)).toEqual(
        Array.from({ length: MAX_BATCH_EVENTS + 2 }, (_, i) => `w${i}`)
      );
    });

    it('starts a new batch rather than send more than MAX_IN_BAND_CREATION_BATCH_BYTES in one', async () => {
      const { world, writer, releaseAll } = await ready();
      // Each write alone fits a batch; any two together do not.
      const sized = (cid: string) => ({
        ...waitCreated(cid),
        eventData: {
          resumeAt: new Date(),
          payload: new Uint8Array(
            Math.ceil(MAX_IN_BAND_CREATION_BATCH_BYTES * 0.6)
          ),
        },
      });
      const writes = ['w1', 'w2', 'w3'].map((cid) =>
        writer.createAhead(sized(cid) as never, {}, () => {})
      );
      await releaseAll();
      // The World refuses an oversized batch whole.
      await Promise.all(writes);
      expect(world.batches.every((batch) => batch.length === 1)).toBe(true);
      expect(world.events.slice(1).map((e) => e.correlationId)).toEqual([
        'w1',
        'w2',
        'w3',
      ]);
    });

    it('does not move a run-ahead write past a plain write queued before it', async () => {
      const { world, writer, releaseAll } = await ready();
      const writes = [
        writer.createAhead(waitCreated('w1'), {}, () => {}),
        writer.createAhead(waitCreated('w2'), {}, () => {}),
        writer.create(waitCreated('plain')),
        writer.createAhead(waitCreated('w3'), {}, () => {}),
      ];
      await releaseAll();
      await Promise.all(writes);

      expect(world.events.slice(1).map((e) => e.correlationId)).toEqual([
        'w1',
        'w2',
        'plain',
        'w3',
      ]);
    });

    it('stops the writer at a failed check, failing every run-ahead write behind it', async () => {
      const { world, writer, releaseAll } = await ready();
      const first = writer.createAhead(waitCreated('w1'), {}, () => {});
      const second = writer.createAhead(waitCreated('w2'), {}, () => {
        throw new Error('landed at the wrong slot');
      });
      const third = writer.createAhead(waitCreated('w3'), {}, () => {});
      const outcomes = Promise.allSettled([first, second, third]);
      await releaseAll();
      const [a, b, c] = await outcomes;

      expect(a.status).toBe('fulfilled');
      expect(b).toMatchObject({ status: 'rejected' });
      expect(c).toMatchObject({ status: 'rejected' });
      expect(writer.isStopped).toBe(true);
      await expect(writer.create(waitCreated('after'))).rejects.toThrow(
        'landed at the wrong slot'
      );
      expect(world.events.some((e) => e.correlationId === 'after')).toBe(false);
    });
  });
});

describe('a rate limit write beside run-ahead writes', () => {
  const rateCreated = (cid: string) =>
    ({
      eventType: 'rate_created',
      specVersion: SPEC_VERSION_RATE_LIMITS,
      correlationId: cid,
      eventData: {
        key: 'k',
        limit: 1000,
        periodMs: 1000,
        expiresAt: new Date(Date.now() + 60_000),
      },
    }) as const;

  async function ready(
    options: ConstructorParameters<typeof AppendOnlyWorld>[0]
  ) {
    const gates: (() => void)[] = [];
    let held = false;
    const world = seeded({
      ...options,
      async beforeCreate() {
        // Hold only the first write, so the writes after it queue up.
        if (held) return;
        held = true;
        await new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    const release = async () => {
      while (gates.length === 0) await new Promise((r) => setTimeout(r, 0));
      gates.shift()?.();
    };
    return { world, writer, release };
  }

  it('rides in the open run-ahead group as its last write, and closes it', async () => {
    const { world, writer, release } = await ready({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      rateEventsInBatch: true,
    });
    const inFlight = writer.create(waitCreated('first'));
    const ahead = writer.createAhead(waitCreated('ahead'), {}, () => {});
    const rate = writer.create(rateCreated('rate_1'));
    // After the rate write: a group of its own, behind the batch.
    const after = writer.createAhead(waitCreated('after'), {}, () => {});
    await release();
    await Promise.all([inFlight, ahead, after]);
    const result = await rate;

    expect(world.batches).toEqual([['wait_created', 'rate_created']]);
    // What the World committed in its place comes back as the write's own.
    expect(result.event?.eventType).toBe('rate_acquired');
    expect(world.events.slice(1).map((e) => e.correlationId)).toEqual([
      'first',
      'ahead',
      'rate_1',
      'after',
    ]);
    expect(writer.expectedSeqInBand).toBe(5);
  });

  it('waits its own turn on a World without the capability', async () => {
    const { world, writer, release } = await ready({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    const inFlight = writer.create(waitCreated('first'));
    const ahead = writer.createAhead(waitCreated('ahead'), {}, () => {});
    const rate = writer.create(rateCreated('rate_1'));
    await release();
    await Promise.all([inFlight, ahead, rate]);
    // Nothing batched a rate event.
    expect(world.batches.flat()).not.toContain('rate_created');
    expect(world.events.slice(1).map((e) => e.correlationId)).toEqual([
      'first',
      'ahead',
      'rate_1',
    ]);
  });

  it('fails a refused rate write alone, and the writer goes on', async () => {
    // A run below spec 10: the World refuses the rate event (400).
    const { world, writer, release } = await ready({ rateEventsInBatch: true });
    const inFlight = writer.create(waitCreated('first'));
    const ahead = writer.createAhead(waitCreated('ahead'), {}, () => {});
    const rate = writer.create(rateCreated('rate_1'));
    const rateError = rate.catch((error: unknown) => error);
    await release();
    await Promise.all([inFlight, ahead]);
    const error = await rateError;

    expect(world.batches).toEqual([['wait_created', 'rate_created']]);
    expect(WorkflowWorldError.is(error)).toBe(true);
    expect((error as WorkflowWorldError).status).toBe(400);
    expect(EntityConflictError.is(error)).toBe(false);
    // The refused item's position was sealed and counted; the next write
    // carries the right expected count and lands.
    await writer.create(waitCreated('next'));
    expect(world.events.at(-1)?.correlationId).toBe('next');
    expect(writer.isSuperseded).toBe(false);
  });

  it('sends rate writes made at once in one batch', async () => {
    const world = seeded({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      rateEventsInBatch: true,
    });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    const results = await Promise.all(
      ['rate_1', 'rate_2', 'rate_3'].map((cid) =>
        writer.create(rateCreated(cid))
      )
    );

    expect(world.batches).toEqual([
      ['rate_created', 'rate_created', 'rate_created'],
    ]);
    // Each call gets its own answer, in request order.
    expect(results.map((r) => r.event?.correlationId)).toEqual([
      'rate_1',
      'rate_2',
      'rate_3',
    ]);
    expect(writer.expectedSeqInBand).toBe(4);
  });

  it('sends a lone rate write as a single write', async () => {
    const world = seeded({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      rateEventsInBatch: true,
    });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    const result = await writer.create(rateCreated('rate_1'));

    expect(world.batches).toEqual([]);
    expect(result.event?.eventType).toBe('rate_acquired');
  });

  it('joins the calls queued behind a write in flight, and no run-ahead write after them', async () => {
    const { world, writer, release } = await ready({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      rateEventsInBatch: true,
    });
    const inFlight = writer.create(waitCreated('first'));
    const ahead = writer.createAhead(waitCreated('ahead'), {}, () => {});
    const rates = [
      writer.create(rateCreated('rate_1')),
      writer.create(rateCreated('rate_2')),
    ];
    const after = writer.createAhead(waitCreated('after'), {}, () => {});
    await release();
    await Promise.all([inFlight, ahead, after, ...rates]);

    expect(world.batches).toEqual([
      ['wait_created', 'rate_created', 'rate_created'],
    ]);
    expect(world.events.slice(1).map((e) => e.correlationId)).toEqual([
      'first',
      'ahead',
      'rate_1',
      'rate_2',
      'after',
    ]);
  });

  it('sends again a rate write the World refused before deciding it', async () => {
    const refused = new Set<string>();
    const world = seeded({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      rateEventsInBatch: true,
      // The first time it sees rate_2: deferred, nothing reserved.
      refuseBatchedRate: (event) => {
        const cid = event.correlationId ?? '';
        if (cid !== 'rate_2' || refused.has(cid)) return undefined;
        refused.add(cid);
        return { status: 503, error: 'rate-batch-deferred' };
      },
    });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    const results = await Promise.all(
      ['rate_1', 'rate_2', 'rate_3'].map((cid) =>
        writer.create(rateCreated(cid))
      )
    );

    // Sent again on its own: a lone write goes out as a single write.
    expect(world.batches).toEqual([
      ['rate_created', 'rate_created', 'rate_created'],
    ]);
    expect(results.map((r) => r.event?.correlationId)).toEqual([
      'rate_1',
      'rate_2',
      'rate_3',
    ]);
    expect(
      world.events
        .filter((e) => e.eventType !== 'noop')
        .slice(1)
        .map((e) => e.correlationId)
    ).toEqual(['rate_1', 'rate_3', 'rate_2']);
    expect(writer.isStopped).toBe(false);
    // The next write carries the right expected count and lands.
    await writer.create(waitCreated('next'));
    expect(world.events.at(-1)?.correlationId).toBe('next');
  });

  it.each([
    { status: 503, error: 'rate-batch-deferred', sentAgain: true },
    { status: 503, error: 'rate-decision-failed', sentAgain: true },
    { status: 400, error: 'invalid-rate-call', sentAgain: false },
  ])("hands the batch's skipped-slot report to the first write that is answered ($error)", async ({
    status,
    error,
    sentAgain,
  }) => {
    const refused = new Set<string>();
    const world = seeded({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      rateEventsInBatch: true,
      // The group's first write is refused once: its caller never sees this
      // batch's answer, whether it is sent again or fails.
      refuseBatchedRate: (event) => {
        const cid = event.correlationId ?? '';
        if (cid !== 'rate_1' || refused.has(cid)) return undefined;
        refused.add(cid);
        return { status, error };
      },
    });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    // Another writer's event lands below the batch, unseen by this writer.
    const foreign = world.appendOutOfBand({
      eventType: 'hook_received',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      correlationId: 'hook_other',
      eventData: { payload: new Uint8Array() },
    } as never);
    const [first, second] = await Promise.allSettled(
      ['rate_1', 'rate_2'].map((cid) =>
        writer.create(rateCreated(cid), { eventCount: 1 })
      )
    );

    expect(world.batches).toEqual([['rate_created', 'rate_created']]);
    // The batch counted the report as delivered (later writes name a
    // position above it), so the write it answered carries it.
    assert(second?.status === 'fulfilled');
    expect(second.value.events?.map((e) => e.eventId)).toEqual([
      foreign.eventId,
    ]);
    if (sentAgain) {
      assert(first?.status === 'fulfilled');
      expect(first.value.events ?? []).toEqual([]);
      expect(first.value.event?.correlationId).toBe('rate_1');
    } else {
      expect(first?.status).toBe('rejected');
    }
    expect(writer.isStopped).toBe(false);
  });

  it('fails a rate write the World keeps refusing before deciding it', async () => {
    const world = seeded({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      rateEventsInBatch: true,
      refuseBatchedRate: (event) =>
        event.correlationId === 'rate_1'
          ? undefined
          : { status: 503, error: 'rate-decision-failed' },
    });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    // Two refused calls, so each resend goes out as a batch again.
    const settled = await Promise.allSettled(
      ['rate_1', 'rate_2', 'rate_3'].map((cid) =>
        writer.create(rateCreated(cid))
      )
    );

    expect(world.batches).toEqual([
      ['rate_created', 'rate_created', 'rate_created'],
      ['rate_created', 'rate_created'],
      ['rate_created', 'rate_created'],
    ]);
    expect(settled.map((s) => s.status)).toEqual([
      'fulfilled',
      'rejected',
      'rejected',
    ]);
    const error = (settled[1] as PromiseRejectedResult).reason;
    expect(WorkflowWorldError.is(error)).toBe(true);
    expect((error as WorkflowWorldError).status).toBe(503);
    expect(writer.isStopped).toBe(false);
  });

  it('does not count a refusal behind another item against the resends', async () => {
    let batch = -1;
    let refusedInBatch = false;
    const world: AppendOnlyWorld = seeded({
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      rateEventsInBatch: true,
      // Each batch's first item is too early; the World puts nothing after
      // a refused rate item, so every later one is refused behind it.
      refuseBatchedRate: () => {
        if (world.batches.length !== batch) {
          batch = world.batches.length;
          refusedInBatch = false;
        }
        if (refusedInBatch) {
          return { status: 409, error: 'batch-earlier-position-failed' };
        }
        refusedInBatch = true;
        return { status: 425, error: 'TooEarlyError' };
      },
    });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      requireLoadSnapshot(
        RUN,
        await loadWorkflowRunEventsFrom(world.asWorld(), RUN)
      )
    );
    const settled = await Promise.allSettled(
      ['rate_1', 'rate_2', 'rate_3', 'rate_4'].map((cid) =>
        writer.create(rateCreated(cid))
      )
    );

    // rate_4 is refused behind another item three times, one more than the
    // resends a refusal of its own gets, and still lands, alone.
    expect(world.batches).toEqual([
      ['rate_created', 'rate_created', 'rate_created', 'rate_created'],
      ['rate_created', 'rate_created', 'rate_created'],
      ['rate_created', 'rate_created'],
    ]);
    expect(settled.map((s) => s.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'fulfilled',
    ]);
    for (const refused of settled.slice(0, 3)) {
      expect(TooEarlyError.is((refused as PromiseRejectedResult).reason)).toBe(
        true
      );
    }
    expect(writer.isStopped).toBe(false);
  });
});
