import { WorkflowWorldError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { loadWorkflowRunEventsFrom } from '../../test-support/load-events.js';
import { InBandWriter, OrchestratorSupersededError } from './in-band-writer.js';

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
    const world = seeded({ fence: true });
    const writer = new InBandWriter(world.asWorld(), RUN);
    const log = await loadWorkflowRunEventsFrom(world.asWorld(), RUN);
    writer.adoptSnapshot(log.snapshot);
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

  it('out-of-band writes move seq but not the in-band count', async () => {
    const world = seeded({ fence: true });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      (await loadWorkflowRunEventsFrom(world.asWorld(), RUN)).snapshot
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
    const world = seeded({ fence: true });
    const stale = new InBandWriter(world.asWorld(), RUN);
    const winner = new InBandWriter(world.asWorld(), RUN);
    const snapshot = (await loadWorkflowRunEventsFrom(world.asWorld(), RUN))
      .snapshot;
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
    const world = seeded({ fence: true });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      (await loadWorkflowRunEventsFrom(world.asWorld(), RUN)).snapshot
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

  it('marks writes in-band without a count on a World without the fence', async () => {
    const world = seeded({});
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      (await loadWorkflowRunEventsFrom(world.asWorld(), RUN)).snapshot
    );
    await writer.create(waitCreated('wait_a'));
    expect(world.creates[0]?.params).toMatchObject({ inBand: true });
    expect(world.creates[0]?.params?.expectedSeqInBand).toBeUndefined();
  });

  it('does not advance for a write answered with an event it already knew (idempotent replay)', async () => {
    const world = seeded({});
    const base = world.asWorld();
    const existing = world.events[0];
    const replaying = {
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
    const world = seeded({ fence: true });
    const writer = new InBandWriter(world.asWorld(), RUN);
    writer.adoptSnapshot(
      (await loadWorkflowRunEventsFrom(world.asWorld(), RUN)).snapshot
    );
    await writer.create(waitCreated('wait_a'));
    expect(world.creates[0]?.params?.eventCount).toBe(1);
    await writer.create(waitCreated('wait_b'), { eventCount: 2 });
    expect(world.creates[1]?.params?.eventCount).toBe(2);
  });
});
