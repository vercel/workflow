import { RUN_ERROR_CODES, WorkflowWorldError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { loadWorkflowRunEventsFrom } from '../../test-support/load-events.js';
import { MAX_BATCH_EVENTS } from '../constants.js';
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

const waitCreated = (cid: string) =>
  ({
    eventType: 'wait_created',
    specVersion: SPEC_VERSION_CURRENT,
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
      specVersion: SPEC_VERSION_CURRENT,
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
