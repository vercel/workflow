import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { loadWorkflowRunEventsFrom } from '../../test-support/load-events.js';
import { slotSnapshotParams } from '../helpers.js';
import { consumeOwnResolvingWrite } from './consume-after-commit.js';
import { InBandWriter } from './in-band-writer.js';

const RUN = 'wrun_cac';

function seeded(options: ConstructorParameters<typeof AppendOnlyWorld>[0]) {
  const world = new AppendOnlyWorld(options);
  world.seedRun({
    runId: RUN,
    workflowName: 'wf',
    deploymentId: 'dpl',
    status: 'running',
    input: new Uint8Array(),
  } as unknown as WorkflowRun);
  return world;
}

const waitCompleted = {
  eventType: 'wait_completed',
  specVersion: SPEC_VERSION_CURRENT,
  correlationId: 'wait_a',
} as const;

describe('consumeOwnResolvingWrite', () => {
  it('feeds an unseen out-of-band event before the own resolving event', async () => {
    const world = seeded({ fence: true });
    const writer = new InBandWriter(world.asWorld(), RUN);
    const log = await loadWorkflowRunEventsFrom(world.asWorld(), RUN);
    writer.adoptSnapshot(log.snapshot);

    // A background step's outcome commits after the load, below the
    // orchestrator's own wait_completed.
    const outcome = world.appendOutOfBand({
      eventType: 'step_completed',
      correlationId: 'step_bg',
      eventData: { stepName: 's', result: new Uint8Array() },
    } as Partial<Event>);

    const result = await writer.create(
      waitCompleted,
      slotSnapshotParams(log.events)
    );
    const merged = consumeOwnResolvingWrite(log.events, result);

    expect(merged).toEqual({ type: 'merged', added: 2 });
    expect(log.events.map((e) => e.eventId)).toEqual([
      log.events[0]?.eventId,
      outcome.eventId,
      result.event?.eventId,
    ]);
  });

  it('consumes immediately when the report is empty', async () => {
    const world = seeded({ fence: true });
    const writer = new InBandWriter(world.asWorld(), RUN);
    const log = await loadWorkflowRunEventsFrom(world.asWorld(), RUN);
    writer.adoptSnapshot(log.snapshot);
    const result = await writer.create(
      waitCompleted,
      slotSnapshotParams(log.events)
    );
    expect(consumeOwnResolvingWrite(log.events, result)).toEqual({
      type: 'merged',
      added: 1,
    });
    expect(log.events.at(-1)?.eventType).toBe('wait_completed');
  });

  it('asks for a reload when the report is incomplete', async () => {
    const world = seeded({ fence: true, reportIncomplete: true });
    const writer = new InBandWriter(world.asWorld(), RUN);
    const log = await loadWorkflowRunEventsFrom(world.asWorld(), RUN);
    writer.adoptSnapshot(log.snapshot);
    const before = log.events.length;
    const result = await writer.create(
      waitCompleted,
      slotSnapshotParams(log.events)
    );
    expect(consumeOwnResolvingWrite(log.events, result)).toEqual({
      type: 'reload',
    });
    expect(log.events.length).toBe(before);
  });

  it('asks for a reload when the report is truncated', () => {
    expect(
      consumeOwnResolvingWrite([], {
        event: { eventId: 'evnt_x' } as Event,
        events: [],
        cursor: null,
        hasMore: true,
      })
    ).toEqual({ type: 'reload' });
  });
});
