import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  slotToEventId,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeDueWaits, findDueWaits } from './due-waits.js';
import { setWorld } from './world.js';

const runId = 'wrun_due_waits';
const now = new Date('2026-05-19T12:00:00.000Z');

let eventIndex = 0;
function event(data: CreateEventRequest): Event {
  eventIndex += 1;
  return {
    ...data,
    specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
    runId,
    eventId: slotToEventId(eventIndex),
    createdAt: now,
  } as Event;
}

function waitCreated(correlationId: string, resumeAt: Date): Event {
  return event({
    eventType: 'wait_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId,
    eventData: { resumeAt },
  });
}

function waitCompleted(correlationId: string): Event {
  return event({
    eventType: 'wait_completed',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId,
  });
}

/**
 * A World that records `events.create` calls, optionally rejecting
 * `wait_completed` writes with `reject`.
 */
function fakeWorld(reject?: (correlationId: string) => unknown) {
  const create = vi.fn(async (_runId: string, data: CreateEventRequest) => {
    if (data.eventType === 'wait_completed' && reject) {
      const err = reject(data.correlationId);
      if (err) throw err;
    }
    return { event: event(data) };
  });
  const list = vi.fn();
  const world = {
    specVersion: SPEC_VERSION_CURRENT,
    events: { create, list },
  } as unknown as World;
  return { world, create, list };
}

describe('findDueWaits', () => {
  it('returns waits whose resumeAt has passed and that have no completion', () => {
    const due = findDueWaits(
      [
        waitCreated('wait_past', new Date(+now - 1_000)),
        waitCreated('wait_exactly_now', now),
        waitCreated('wait_future', new Date(+now + 1_000)),
        waitCreated('wait_done', new Date(+now - 1_000)),
        waitCompleted('wait_done'),
      ],
      +now
    );

    expect(due.map((w) => w.correlationId)).toEqual([
      'wait_past',
      'wait_exactly_now',
    ]);
    expect(due[0]?.resumeAt).toEqual(new Date(+now - 1_000));
  });

  it('accepts a resumeAt that arrived as a string', () => {
    const created = waitCreated('wait_str', new Date(+now - 1_000));
    (created as { eventData: { resumeAt: unknown } }).eventData.resumeAt =
      new Date(+now - 1_000).toISOString();

    expect(findDueWaits([created], +now).map((w) => w.correlationId)).toEqual([
      'wait_str',
    ]);
  });

  it('leaves a wait alone when its deadline cannot be read', () => {
    const created = waitCreated('wait_bad', new Date(+now - 1_000));
    (created as { eventData: { resumeAt: unknown } }).eventData.resumeAt =
      'not-a-date';

    expect(findDueWaits([created], +now)).toEqual([]);
  });
});

describe('completeDueWaits', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  it('records a wait_completed carrying the wait_created resumeAt', async () => {
    const { world, create } = fakeWorld();
    const resumeAt = new Date(+now - 5_000);

    const summary = await completeDueWaits({
      world,
      runId,
      events: [waitCreated('wait_1', resumeAt)],
      requestId: 'req_1',
      now: +now,
    });

    expect(summary).toEqual({
      completed: ['wait_1'],
      alreadyCompleted: [],
      unrecordable: [],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      runId,
      {
        eventType: 'wait_completed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: 'wait_1',
        eventData: { resumeAt },
      },
      { requestId: 'req_1' }
    );
  });

  it('writes nothing when no wait is due', async () => {
    const { world, create } = fakeWorld();

    const summary = await completeDueWaits({
      world,
      runId,
      events: [
        waitCreated('wait_future', new Date(+now + 60_000)),
        waitCreated('wait_done', new Date(+now - 60_000)),
        waitCompleted('wait_done'),
      ],
      now: +now,
    });

    expect(summary.completed).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('loads the event log when the caller has none', async () => {
    const { world, create, list } = fakeWorld();
    list.mockResolvedValue({
      data: [waitCreated('wait_loaded', new Date(+now - 1_000))],
      hasMore: false,
      cursor: null,
    });
    // loadWorkflowRunEvents reads the ambient World, not the argument.
    setWorld(world);

    const summary = await completeDueWaits({ world, runId, now: +now });

    expect(list).toHaveBeenCalledTimes(1);
    expect(summary.completed).toEqual(['wait_loaded']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('treats a concurrent completion as done, not as a failure', async () => {
    const { world } = fakeWorld(
      () => new EntityConflictError('Wait "wait_1" already completed')
    );

    const summary = await completeDueWaits({
      world,
      runId,
      events: [waitCreated('wait_1', new Date(+now - 1_000))],
      now: +now,
    });

    expect(summary).toEqual({
      completed: [],
      alreadyCompleted: ['wait_1'],
      unrecordable: [],
    });
  });

  it('reports a wait an older World cannot record, without failing the delivery', async () => {
    // A backend that drops a terminal run's waits outright has nowhere to put
    // the completion. Redelivery would reach the same verdict, so the caller
    // must still be free to acknowledge.
    const { world } = fakeWorld(
      (correlationId) =>
        new WorkflowWorldError(`Wait "${correlationId}" not found`)
    );

    const summary = await completeDueWaits({
      world,
      runId,
      events: [waitCreated('wait_1', new Date(+now - 1_000))],
      now: +now,
    });

    expect(summary).toEqual({
      completed: [],
      alreadyCompleted: [],
      unrecordable: ['wait_1'],
    });
  });

  it('rethrows a retryable World failure so the message is redelivered', async () => {
    const { world } = fakeWorld(
      () => new WorkflowWorldError('upstream unavailable', { status: 503 })
    );

    await expect(
      completeDueWaits({
        world,
        runId,
        events: [waitCreated('wait_1', new Date(+now - 1_000))],
        now: +now,
      })
    ).rejects.toThrow('upstream unavailable');
  });

  it('completes every due wait even when one of them cannot be recorded', async () => {
    const { world, create } = fakeWorld((correlationId) =>
      correlationId === 'wait_1'
        ? new WorkflowWorldError('Wait "wait_1" not found')
        : undefined
    );

    const summary = await completeDueWaits({
      world,
      runId,
      events: [
        waitCreated('wait_1', new Date(+now - 2_000)),
        waitCreated('wait_2', new Date(+now - 1_000)),
      ],
      now: +now,
    });

    expect(summary.unrecordable).toEqual(['wait_1']);
    expect(summary.completed).toEqual(['wait_2']);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('uses the legacy write shape for a legacy run', async () => {
    const { world, create } = fakeWorld();

    await completeDueWaits({
      world,
      runId,
      events: [waitCreated('wait_1', new Date(+now - 1_000))],
      specVersion: SPEC_VERSION_LEGACY,
      now: +now,
    });

    expect(create).toHaveBeenCalledWith(
      runId,
      { eventType: 'wait_completed', correlationId: 'wait_1' },
      { requestId: undefined, v1Compat: true }
    );
  });
});
